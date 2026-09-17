/**
 * Real-composition integration tests for inbound context merge: a group
 * @-mention with NO text of its own absorbs the sender's immediately
 * preceding messages — the ones the mention gate dropped, so the agent never
 * saw them — into the same turn. A real dsh process boots from the real
 * profile with only Feishu (memory transport) and the LLM API (mock server)
 * mocked.
 *
 * Self-skips when the environment lacks a prepared profile or the dsh CLI,
 * like the sibling real-composition suites (see docs/development.md →
 * "Integration test").
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryOutboxRecord } from '../../src/memory-transport.js';
import { type MockLlmServer, startMockLlmServer } from './mock-llm-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Each integration suite uses its OWN dsh home: the suites run in parallel
// (vitest file parallelism) and spawn real dsh processes that share
// `_dev/dsh-home/feishu/session-map.json` — concurrent writes raced and
// silently dropped another suite's chat→session binding (CI-only flakes).
const DSH_HOME =
  process.env.FEISHU_INT_CONTEXT_MERGE_DSH_HOME ??
  join(REPO_ROOT, '_dev', 'dsh-home-context-merge');
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'feishu-dev');
const MEMORY_DIR = join(REPO_ROOT, '_dev', 'int-memory-context-merge');
const INBOX_DIR = join(MEMORY_DIR, 'inbox');
const OUTBOX_DIR = join(MEMORY_DIR, 'outbox');
const INT_CWD = join(REPO_ROOT, '_dev', 'int-cwd-context-merge');
const BOT_OPEN_ID = 'ou_bot';

function resolveDshBin(): string | undefined {
  if (process.env.DSH_BIN !== undefined && process.env.DSH_BIN !== '') return process.env.DSH_BIN;
  const probe = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim() !== '') return probe.stdout.trim();
  return undefined;
}

function readOutbox(): MemoryOutboxRecord[] {
  let files: string[];
  try {
    files = readdirSync(OUTBOX_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(OUTBOX_DIR, file), 'utf8')) as MemoryOutboxRecord;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is MemoryOutboxRecord => record !== undefined)
    .sort((a, b) => a.seq - b.seq);
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const dshBin = resolveDshBin();
const profileReady = existsSync(join(PROFILE_DIR, 'package.json'));
const built = existsSync(join(REPO_ROOT, 'lib', 'index.js'));
const integrationRequired = process.env.FEISHU_INT_REQUIRED === '1';
const integrationReady = dshBin !== undefined && profileReady && built;
if (integrationRequired && !integrationReady) {
  throw new Error(
    `FEISHU_INT_REQUIRED=1 but integration prerequisites are missing ` +
      `(dsh CLI=${dshBin !== undefined} profile=${profileReady} built=${built})`,
  );
}

/** Drop one inbound message into the message channel. */
function sendMessage(
  chatId: string,
  text: string,
  mentions: readonly string[],
  fixedMessageId: string,
): void {
  writeFileSync(
    join(INBOX_DIR, `${fixedMessageId}.json`),
    JSON.stringify({
      messageId: fixedMessageId,
      chatId,
      chatType: 'group',
      senderOpenId: 'ou_mock',
      text,
      mentions,
      createdAt: Date.now(),
    }),
    'utf8',
  );
}

/** Pin the chat's working directory (/cd; the group gate needs the mention). */
async function pinWorkingDir(chatId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    sendMessage(chatId, `/cd ${INT_CWD}`, [BOT_OPEN_ID], `om-cd-${attempt}-${Date.now()}`);
    try {
      await waitFor(
        'the /cd confirmation',
        () =>
          readOutbox().some(
            (r) =>
              r.kind === 'text' &&
              r.chatId === chatId &&
              r.text?.includes('Working directory set to'),
          ),
        20_000,
      );
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

describe.skipIf(!integrationReady)('integration > inbound-context-merge', () => {
  let mock: MockLlmServer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stdout = '';
  let stderr = '';
  let bridgeReady = false;

  async function stopChild(): Promise<void> {
    const proc = child;
    child = undefined;
    if (proc === undefined || proc.exitCode !== null) return;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
        resolve();
      }, 5_000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  beforeEach(async () => {
    if (mock !== undefined) await mock.close();
    await stopChild();
    rmSync(MEMORY_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(INT_CWD, { recursive: true });
    mkdirSync(INBOX_DIR, { recursive: true });
    mkdirSync(OUTBOX_DIR, { recursive: true });
    mock = await startMockLlmServer();
    bridgeReady = false;
    stdout = '';
    stderr = '';
  });

  afterEach(async () => {
    await stopChild();
    if (mock !== undefined) await mock.close();
  });

  /** Boot the real dsh process against the memory transport + mock LLM. */
  async function boot(): Promise<{ chatId: string }> {
    const bin = dshBin;
    if (bin === undefined) throw new Error('dsh CLI unavailable');
    const server = mock;
    if (server === undefined) throw new Error('mock LLM server unavailable');
    child = spawn(bin, ['--profile', 'feishu-dev'], {
      env: {
        ...process.env,
        DSH_HOME,
        FEISHU_APP_ID: 'cli_mock_app',
        FEISHU_APP_SECRET: 'mock_secret',
        FEISHU_TRANSPORT: 'memory',
        FEISHU_MEMORY_DIR: MEMORY_DIR,
        FEISHU_MOCK_BOT_OPEN_ID: BOT_OPEN_ID,
        DEEPSEEK_API_KEY: 'mock_key',
        DEEPSEEK_BASE_URL: server.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('[feishu] bridge ready')) bridgeReady = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await waitFor('the bridge to report ready', () => bridgeReady, 30_000);
    const chatId = `oc_cm_${Date.now()}`;
    await pinWorkingDir(chatId);
    return { chatId };
  }

  /** The last request body the mock LLM received (agent's view of the turn). */
  function agentPrompt(): string {
    return JSON.stringify(
      (mock?.lastRequestBody() as { messages?: unknown[] } | undefined)?.messages ?? [],
    );
  }

  it("a text-less @-mention absorbs the sender's unmentioned preceding messages", async () => {
    const { chatId } = await boot();
    // The mention gate drops these (no @), so the agent never sees them as
    // turns — they are exactly what the merge has to recover. Each send gets
    // its own inbox drain tick (the transport polls), so the arrival order is
    // deterministic.
    //
    // The queue mirrors the reported scenario: an unrelated member speaks
    // first, then the user fires two messages and @-mentions the bot with an
    // EMPTY body — the run must stop at 小义1, not sweep past it.
    sendMessage(chatId, '小义1', [], 'om-cm-1');
    await sleep(600);
    sendMessage(chatId, '小蕊1', [], 'om-cm-2');
    await sleep(600);
    sendMessage(chatId, '小蕊2', [], 'om-cm-3');
    await sleep(600);
    sendMessage(chatId, '', [BOT_OPEN_ID], 'om-cm-4');

    try {
      await waitFor(
        'the merged context in the agent turn',
        () => {
          const prompt = agentPrompt();
          return prompt.includes('小蕊2') && prompt.includes('@-mentioned you in this group');
        },
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${String(error)}\n--- dsh stdout ---\n${stdout}\n--- dsh stderr ---\n${stderr}\n--- prompt ---\n${agentPrompt()}`,
      );
    }
    const prompt = agentPrompt();
    expect(prompt).toContain('小蕊1');
    expect(prompt).toContain('小蕊2');
    expect(prompt).not.toContain('小义1');
  }, 150_000);
});

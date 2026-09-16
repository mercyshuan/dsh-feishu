/**
 * Unit tests for the local identity alias table and the identity block it
 * feeds (inbound identity injection).
 *
 * File-backed cases use a scratch path under `_dev/` (git-ignored) because the
 * development sandbox only permits writes inside the workspace. `node:fs` is
 * mocked ONLY to count `readFileSync` calls: the hot-reload contract is
 * "re-read when the file changed, otherwise reuse memory", which is invisible
 * from the outside without counting the reads.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      reads.count += 1;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

import { IdentityAliasStore, identityBlockText } from '../src/identity-aliases.js';

const SCRATCH = join(process.cwd(), '_dev', 'test-identity-aliases');
const FILE = join(SCRATCH, 'identity-aliases.json');

/** One alias table document as the operator writes it. */
function table(aliases: Record<string, unknown>, version: unknown = 1): string {
  return JSON.stringify({ version, aliases }, null, 2);
}

/** A logger that records every line it is handed, for the degradation asserts. */
function recordingLogger(): {
  debug: (message: string) => void;
  warn: (message: string) => void;
  debugLines: string[];
  warnLines: string[];
} {
  const debugLines: string[] = [];
  const warnLines: string[] = [];
  return {
    debug: (message: string) => {
      debugLines.push(message);
    },
    warn: (message: string) => {
      warnLines.push(message);
    },
    debugLines,
    warnLines,
  };
}

/** The identity block's input for a registered `ou_wang` in a p2p chat. */
const WANG = {
  senderOpenId: 'ou_wang',
  chatId: 'oc_chat',
  chatType: 'p2p' as const,
  aliasesFile: FILE,
};

describe('identityBlockText', () => {
  it('names the registered person (nickname + name + knowledge base) in the fact line', () => {
    const text = identityBlockText({
      ...WANG,
      alias: { name: '王天义', nickname: '小义', knowledgeBase: 'D:\\feishu-agent\\docs\\wangtianyi' },
    });
    expect(text.split('\n')).toEqual([
      '[Feishu identity] 当前对话对象：小义（王天义）· 知识库：D:\\feishu-agent\\docs\\wangtianyi · sender_open_id=ou_wang · chat=oc_chat · 类型：私聊',
      '（这是本次请求的发送者身份；按其身份作答，关于此人的个人信息只读写其知识库。）',
    ]);
  });

  it('uses the bare name (no empty parentheses) when no nickname is registered', () => {
    const text = identityBlockText({ ...WANG, alias: { name: '王天义' } });
    expect(text.split('\n')[0]).toBe(
      '[Feishu identity] 当前对话对象：王天义 · sender_open_id=ou_wang · chat=oc_chat · 类型：私聊',
    );
    expect(text).not.toContain('（）');
  });

  it('omits the whole knowledge-base segment when none is registered', () => {
    const text = identityBlockText({ ...WANG, alias: { name: '王天义', nickname: '小义' } });
    expect(text.split('\n')[0]).toBe(
      '[Feishu identity] 当前对话对象：小义（王天义） · sender_open_id=ou_wang · chat=oc_chat · 类型：私聊',
    );
    expect(text.split('\n')[0]).not.toContain('知识库：');
  });

  it('reports an unregistered sender as unknown and points at the alias file', () => {
    const text = identityBlockText({ ...WANG, senderOpenId: 'ou_nobody', alias: undefined });
    expect(text.split('\n')).toEqual([
      '[Feishu identity] 未知发件人 · sender_open_id=ou_nobody · chat=oc_chat · 类型：私聊',
      `（这是本次请求的发送者身份，但尚未登记姓名；在依赖身份作答前先向对方确认，并提示把结果登记到别名表文件：${FILE}。）`,
    ]);
  });

  it('reports the chat type as 群聊 for a group message', () => {
    const text = identityBlockText({
      ...WANG,
      chatId: 'oc_group',
      chatType: 'group',
      alias: { name: '王天义', nickname: '小义' },
    });
    expect(text.split('\n')[0]).toBe(
      '[Feishu identity] 当前对话对象：小义（王天义） · sender_open_id=ou_wang · chat=oc_group · 类型：群聊',
    );
  });
});

describe('IdentityAliasStore', () => {
  beforeEach(() => {
    reads.count = 0;
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  afterEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('resolves a registered open id and misses an unregistered one', () => {
    writeFileSync(
      FILE,
      table({ ou_wang: { name: '王天义', nickname: '小义', knowledgeBase: 'kb/wang' } }),
    );
    const store = new IdentityAliasStore(FILE);
    expect(store.lookup('ou_wang')).toEqual({
      name: '王天义',
      nickname: '小义',
      knowledgeBase: 'kb/wang',
    });
    expect(store.lookup('ou_nobody')).toBeUndefined();
    expect(store.size).toBe(1);
  });

  it('drops the optional fields that are absent instead of materializing blanks', () => {
    writeFileSync(FILE, table({ ou_wang: { name: '王天义', nickname: '', knowledgeBase: '' } }));
    const store = new IdentityAliasStore(FILE);
    expect(store.lookup('ou_wang')).toEqual({ name: '王天义' });
  });

  it('treats a missing file as an empty table (no throw) and traces it once', () => {
    const logger = recordingLogger();
    const store = new IdentityAliasStore(join(SCRATCH, 'absent.json'), logger);
    expect(store.lookup('ou_wang')).toBeUndefined();
    expect(() => store.lookup('ou_wang')).not.toThrow();
    expect(store.size).toBe(0);
    expect(logger.warnLines).toEqual([]);
  });

  it('degrades a corrupted file to an empty table with a loud warn (never throws)', () => {
    writeFileSync(FILE, '{ this is not json');
    const logger = recordingLogger();
    const store = new IdentityAliasStore(FILE, logger);
    expect(store.lookup('ou_wang')).toBeUndefined();
    expect(store.size).toBe(0);
    expect(logger.warnLines.join('\n')).toContain('not valid JSON');
  });

  it('degrades an unsupported version to an empty table with a loud warn', () => {
    writeFileSync(FILE, table({ ou_wang: { name: '王天义' } }, 99));
    const logger = recordingLogger();
    const store = new IdentityAliasStore(FILE, logger);
    expect(store.lookup('ou_wang')).toBeUndefined();
    expect(logger.warnLines.join('\n')).toContain('unsupported version 99');
  });

  it('keeps the usable entries when one entry has no name', () => {
    writeFileSync(
      FILE,
      table({ ou_broken: { nickname: '无名' }, ou_wang: { name: '王天义', nickname: '小义' } }),
    );
    const logger = recordingLogger();
    const store = new IdentityAliasStore(FILE, logger);
    expect(store.lookup('ou_wang')).toEqual({ name: '王天义', nickname: '小义' });
    expect(store.lookup('ou_broken')).toBeUndefined();
    expect(logger.warnLines.join('\n')).toContain('ou_broken');
  });

  it('hot-reloads: an external rewrite of the file is visible on the next lookup', () => {
    writeFileSync(FILE, table({}));
    const logger = recordingLogger();
    const store = new IdentityAliasStore(FILE, logger);
    expect(store.lookup('ou_wang')).toBeUndefined();
    // The agent registers the person mid-conversation (external write).
    writeFileSync(FILE, table({ ou_wang: { name: '王天义', nickname: '小义' } }));
    expect(store.lookup('ou_wang')).toEqual({ name: '王天义', nickname: '小义' });
    // A later edit (nickname change) is picked up too.
    writeFileSync(FILE, table({ ou_wang: { name: '王天义', nickname: '小义义' } }));
    expect(store.lookup('ou_wang')?.nickname).toBe('小义义');
  });

  it('reads the file once while it is unchanged (no per-message disk IO)', () => {
    writeFileSync(FILE, table({ ou_wang: { name: '王天义' } }));
    const store = new IdentityAliasStore(FILE);
    expect(store.lookup('ou_wang')?.name).toBe('王天义');
    expect(reads.count).toBe(1);
    // Five more lookups on an unchanged file: still one read.
    for (let i = 0; i < 5; i += 1) store.lookup('ou_wang');
    expect(reads.count).toBe(1);
    // The external rewrite invalidates the cache: exactly one re-read.
    writeFileSync(FILE, table({ ou_wang: { name: '王天义', nickname: '小义' } }));
    expect(store.lookup('ou_wang')?.nickname).toBe('小义');
    expect(reads.count).toBe(2);
  });

  it('recovers from a corrupted revision once the file is repaired', () => {
    writeFileSync(FILE, 'not json at all');
    const store = new IdentityAliasStore(FILE);
    expect(store.lookup('ou_wang')).toBeUndefined();
    writeFileSync(FILE, table({ ou_wang: { name: '王天义' } }));
    expect(store.lookup('ou_wang')?.name).toBe('王天义');
  });
});

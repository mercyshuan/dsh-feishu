/**
 * Unit tests for the card-button command seam (`src/card-run.ts`).
 *
 * This seam executes a LOCAL command from a chat button, so the tests cover the
 * security envelope as much as the happy path: an unlisted name never runs,
 * placeholders substitute whole arguments only, unknown placeholders are
 * refused, and a second run in the same chat is refused while the first is
 * alive.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  CardCommandRunner,
  type CardRunContext,
  normalizeCardCommands,
  parseCardRunRequest,
  resolveRunArgs,
} from '../src/card-run.js';

const context: CardRunContext = {
  chatId: 'oc_chat',
  messageId: 'om_card',
  operatorOpenId: 'ou_user',
  formValue: { prompt: '一只猫', width: '512' },
};

function testDir(): string {
  return mkdtempSync(`${tmpdir()}/dsh-feishu-card-run-`);
}

const silentLogger = { info: () => {}, warn: () => {} };

describe('parseCardRunRequest', () => {
  it('accepts a named request with string args', () => {
    const parsed = parseCardRunRequest({ kind: 'run', name: 'image-gen', args: ['--a'] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request).toEqual({ name: 'image-gen', args: ['--a'] });
  });

  it('defaults missing args to an empty list', () => {
    const parsed = parseCardRunRequest({ name: 'x' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.args).toEqual([]);
  });

  it('rejects a missing name and non-string args', () => {
    expect(parseCardRunRequest({}).ok).toBe(false);
    expect(parseCardRunRequest({ name: '' }).ok).toBe(false);
    expect(parseCardRunRequest({ name: 'x', args: [1] }).ok).toBe(false);
  });
});

describe('resolveRunArgs', () => {
  it('substitutes whole-argument placeholders from the callback context', () => {
    const resolved = resolveRunArgs(
      [
        '--card',
        '{card}',
        '--chat',
        '{chat}',
        '--operator',
        '{operator}',
        '--prompt',
        '{form.prompt}',
      ],
      context,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.args).toEqual([
        '--card',
        'om_card',
        '--chat',
        'oc_chat',
        '--operator',
        'ou_user',
        '--prompt',
        '一只猫',
      ]);
    }
  });

  it('never re-parses a substituted value as syntax (one argv element each)', () => {
    // A value that WOULD be shell syntax stays one literal argument.
    const evil: CardRunContext = { ...context, formValue: { prompt: '; rm -rf / #' } };
    const resolved = resolveRunArgs(['{form.prompt}'], evil);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.args).toEqual(['; rm -rf / #']);
  });

  it('refuses unknown non-form placeholders but blanks an unsubmitted form field', () => {
    // A placeholder that is not a known source is a card-authoring bug: refuse.
    expect(resolveRunArgs(['{nope}'], context).ok).toBe(false);
    // A form field the client did not send is client behavior: pass it empty and
    // REPORT it, so the caller can log that the argument was blanked out.
    const resolved = resolveRunArgs(['--prompt', '{form.missing}'], context);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.args).toEqual(['--prompt', '']);
      expect(resolved.missingForm).toEqual(['missing']);
    }
  });

  it('reports no missing form fields when the client sent them all', () => {
    const resolved = resolveRunArgs(['{form.prompt}', '{form.width}'], context);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.missingForm).toEqual([]);
  });

  it('leaves a non-placeholder argument verbatim', () => {
    const resolved = resolveRunArgs(['--flag={card}'], context);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.args).toEqual(['--flag={card}']);
  });

  it('refuses a NUL byte in a substituted value', () => {
    const ctx: CardRunContext = { ...context, formValue: { prompt: 'a\0b' } };
    expect(resolveRunArgs(['{form.prompt}'], ctx).ok).toBe(false);
  });
});

describe('normalizeCardCommands', () => {
  it('drops nameless entries and empty strings', () => {
    expect(
      normalizeCardCommands([
        { name: '  a  ', file: '', args: ['x'], cwd: '' },
        { name: '' },
        { args: ['y'] },
      ]),
    ).toEqual([{ name: 'a', args: ['x'] }]);
  });
});

describe('CardCommandRunner', () => {
  it('runs an allowlisted command with the resolved argv', async () => {
    const dir = testDir();
    const out = join(dir, 'out.txt');
    const runner = new CardCommandRunner(
      [
        {
          name: 'echo',
          file: process.execPath,
          args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', out],
        },
      ],
      { logger: silentLogger, logDir: join(dir, 'logs') },
    );
    const result = runner.run({ name: 'echo', args: ['{form.prompt}'] }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The child is detached; poll briefly for its effect.
    for (let i = 0; i < 50 && !existsSync(out); i += 1) await delay(50);
    expect(readFileSync(out, 'utf8')).toBe('一只猫');
  });

  it('refuses a name that is not in the allowlist', () => {
    const runner = new CardCommandRunner([], { logger: silentLogger, logDir: testDir() });
    const result = runner.run({ name: 'rm', args: ['-rf', '/'] }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not-allowed');
  });

  it('refuses a second run in the same chat while the first is alive', async () => {
    const dir = testDir();
    const runner = new CardCommandRunner(
      [
        {
          name: 'sleep',
          file: process.execPath,
          args: ['-e', 'setTimeout(() => {}, 1200)'],
        },
      ],
      { logger: silentLogger, logDir: join(dir, 'logs') },
    );
    const first = runner.run({ name: 'sleep', args: [] }, context);
    expect(first.ok).toBe(true);
    expect(runner.isBusy('oc_chat')).toBe(true);
    const second = runner.run({ name: 'sleep', args: [] }, context);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('busy');
    // Another chat is NOT blocked by this chat's run.
    const other = runner.run({ name: 'sleep', args: [] }, { ...context, chatId: 'oc_other' });
    expect(other.ok).toBe(true);
  });
});

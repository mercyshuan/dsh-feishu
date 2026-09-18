/**
 * Unit tests for the typed-slash direct-run seam (`src/slash-commands.ts`).
 *
 * The seam runs a LOCAL command from a typed slash line, reusing the
 * card-button runner's security envelope: only a configured entry decides what
 * runs, and the line's own trailing text becomes argv — never shell syntax.
 */

import { describe, expect, it } from 'vitest';
import { normalizeSlashCommands, parseSlashArgs, slashRunResult } from '../src/slash-commands.js';

describe('normalizeSlashCommands', () => {
  it('drops nameless entries and empty strings (same contract as cardCommands)', () => {
    expect(
      normalizeSlashCommands([
        { name: ' stop ', file: '', args: ['a'], cwd: '' },
        { name: '' },
        { args: ['b'] },
      ]),
    ).toEqual([{ name: 'stop', args: ['a'] }]);
  });
});

describe('parseSlashArgs', () => {
  it('splits on whitespace and treats a bare line as no args', () => {
    expect(parseSlashArgs('')).toEqual([]);
    expect(parseSlashArgs('   ')).toEqual([]);
    expect(parseSlashArgs('  --all now  ')).toEqual(['--all', 'now']);
  });

  it('does NOT parse quotes or escapes (a token stays one literal argv)', () => {
    // The runner never re-enters a shell, so quote characters are data.
    expect(parseSlashArgs('"a b" c')).toEqual(['"a', 'b"', 'c']);
    expect(parseSlashArgs('a; rm -rf /')).toEqual(['a;', 'rm', '-rf', '/']);
  });
});

describe('slashRunResult', () => {
  it('names the pid and the capture file when the run started', () => {
    const result = slashRunResult('img', {
      ok: true,
      pid: 42,
      logFile: '/tmp/x.log',
      command: 'x',
    });
    expect(result.kind).toBe('success');
    expect(result.text).toContain('/img');
    expect(result.text).toContain('42');
    expect(result.text).toContain('/tmp/x.log');
  });

  it('maps every refusal code to an error naming the cause', () => {
    const notAllowed = slashRunResult('img', { ok: false, code: 'not-allowed', detail: '' });
    expect(notAllowed.kind).toBe('error');
    expect(notAllowed.text).toContain('slashCommands');

    const busy = slashRunResult('img', { ok: false, code: 'busy', detail: '"other"' });
    expect(busy.kind).toBe('error');
    expect(busy.text).toContain('other');

    const invalid = slashRunResult('img', { ok: false, code: 'invalid', detail: 'bad {x}' });
    expect(invalid.kind).toBe('error');
    expect(invalid.text).toContain('bad {x}');

    const failed = slashRunResult('img', { ok: false, code: 'spawn-failed', detail: 'ENOENT' });
    expect(failed.kind).toBe('error');
    expect(failed.text).toContain('ENOENT');
  });
});

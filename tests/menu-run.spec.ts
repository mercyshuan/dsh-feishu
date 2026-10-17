/**
 * Unit tests for the bot custom-menu seam (`src/menu-run.ts` + the menu event
 * normalizer in `src/transport.ts`).
 *
 * The dispatcher is keyed by a developer-defined `event_key` and nothing else:
 * the event carries no menu name, no menu id and no chat id, so these tests
 * pin down (a) what makes a mapping usable, (b) that an unmapped or key-less
 * event is surfaced rather than guessed at, and (c) that both payload shapes
 * the SDK may hand over are read.
 */

import { describe, expect, it } from 'vitest';
import { MenuCommandTable, normalizeMenuCommands } from '../src/menu-run.js';
import { normalizeBotMenuEvent } from '../src/transport.js';

describe('normalizeMenuCommands', () => {
  it('trims keys and commands and defaults args to an empty list', () => {
    expect(
      normalizeMenuCommands([
        { eventKey: '  imagecard ', command: ' image-gen-create ' },
        { eventKey: 'help', command: 'help-card', args: ['--a', '{operator}'] },
      ]),
    ).toEqual([
      { eventKey: 'imagecard', command: 'image-gen-create', args: [] },
      { eventKey: 'help', command: 'help-card', args: ['--a', '{operator}'] },
    ]);
  });

  it('drops half-configured entries instead of failing the boot', () => {
    expect(
      normalizeMenuCommands([
        { eventKey: 'no_command' },
        { command: 'no_key' },
        { eventKey: '', command: 'x' },
        { eventKey: 'ok', command: 'y' },
      ]),
    ).toEqual([{ eventKey: 'ok', command: 'y', args: [] }]);
  });

  it('treats an absent config as an empty table', () => {
    expect(normalizeMenuCommands(undefined)).toEqual([]);
  });
});

describe('MenuCommandTable', () => {
  it('resolves a key to its command and reports the configured keys', () => {
    const table = new MenuCommandTable(
      normalizeMenuCommands([
        { eventKey: 'a', command: 'cmd-a' },
        { eventKey: 'b', command: 'cmd-b' },
      ]),
    );
    expect(table.size).toBe(2);
    expect(table.keys()).toEqual(['a', 'b']);
    expect(table.resolve('a')).toEqual({ eventKey: 'a', command: 'cmd-a', args: [] });
    expect(table.resolve('missing')).toBeUndefined();
  });

  it('lets the last entry win when a key is configured twice', () => {
    const table = new MenuCommandTable(
      normalizeMenuCommands([
        { eventKey: 'a', command: 'first' },
        { eventKey: 'a', command: 'second' },
      ]),
    );
    expect(table.resolve('a')?.command).toBe('second');
    expect(table.size).toBe(1);
  });
});

describe('normalizeBotMenuEvent', () => {
  it('reads the flattened SDK payload', () => {
    expect(
      normalizeBotMenuEvent({
        event_id: 'evt-1',
        event_type: 'application.bot.menu_v6',
        create_time: '1608725989000',
        event_key: 'imagecard',
        timestamp: 1669364458,
        operator: {
          operator_name: '张三',
          operator_id: { open_id: 'ou_84aa', union_id: 'on_x', user_id: 'e33' },
        },
      }),
    ).toEqual({
      eventKey: 'imagecard',
      operatorOpenId: 'ou_84aa',
      operatorName: '张三',
      eventId: 'evt-1',
      timestamp: 1669364458,
    });
  });

  it('reads a v2.0 envelope that was not flattened', () => {
    expect(
      normalizeBotMenuEvent({
        header: { event_id: 'evt-2', create_time: '1608725989000' },
        event: {
          event_key: 'help',
          timestamp: 1_669_364_458,
          operator: { operator_id: { open_id: 'ou_b' } },
        },
      }),
    ).toEqual({
      eventKey: 'help',
      operatorOpenId: 'ou_b',
      eventId: 'evt-2',
      timestamp: 1_669_364_458,
    });
  });

  it('ignores a payload with no event_key (nothing can be dispatched)', () => {
    expect(normalizeBotMenuEvent({ event_id: 'evt-3' })).toBeUndefined();
    expect(normalizeBotMenuEvent({ event_key: '' })).toBeUndefined();
  });

  it('keeps a click with no operator id (the surface reports the missing chat)', () => {
    expect(normalizeBotMenuEvent({ event_key: 'k' })).toEqual({
      eventKey: 'k',
      operatorOpenId: '',
      eventId: '',
    });
  });
});

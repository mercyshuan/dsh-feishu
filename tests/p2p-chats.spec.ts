/**
 * Unit tests for the durable open-id → p2p-chat table (`src/p2p-chats.ts`).
 *
 * A bot-menu click names only the operator, so this table is the difference
 * between "the click works" and "the click silently does nothing" — and it is
 * the difference between that holding across a restart or not. The tests
 * therefore pin the round-trip AND every degradation path (missing / damaged /
 * future-versioned file), because a bad table must never break delivery.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { P2pChatStore } from '../src/p2p-chats.js';

/** A fresh scratch directory for one test. */
function testDir(): string {
  return mkdtempSync(`${tmpdir()}/dsh-feishu-p2p-chats-`);
}

/** A table path whose parent directory already exists. */
function testFile(dir = testDir()): string {
  return join(dir, 'p2p-chats.json');
}

const silentLogger = { debug: () => {}, warn: () => {} };

describe('P2pChatStore', () => {
  it('remembers a binding and persists it as a versioned document', () => {
    // The parent directory deliberately does NOT exist: persisting must create
    // it, exactly as the session map does.
    const file = join(testDir(), 'nested', 'p2p-chats.json');
    const store = new P2pChatStore(file, silentLogger);
    store.load();
    expect(store.get('ou_a')).toBeUndefined();

    store.set('ou_a', 'oc_1');
    expect(store.get('ou_a')).toBe('oc_1');
    expect(store.size).toBe(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      chats: { ou_a: 'oc_1' },
    });
  });

  it('reloads what a previous process wrote (the restart case)', () => {
    const file = join(testDir(), 'nested', 'p2p-chats.json');
    const first = new P2pChatStore(file, silentLogger);
    first.load();
    first.set('ou_a', 'oc_1');
    first.set('ou_b', 'oc_2');

    const second = new P2pChatStore(file, silentLogger);
    second.load();
    expect(second.size).toBe(2);
    expect(second.get('ou_a')).toBe('oc_1');
    expect(second.get('ou_b')).toBe('oc_2');
  });

  it('ignores blank halves and re-learning the same binding', () => {
    const file = testFile();
    const store = new P2pChatStore(file, silentLogger);
    store.load();
    store.set('', 'oc_1');
    store.set('ou_a', '');
    expect(store.size).toBe(0);

    store.set('ou_a', 'oc_1');
    const before = readFileSync(file, 'utf8');
    store.set('ou_a', 'oc_1');
    expect(store.size).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('degrades to empty for a missing, damaged or future-versioned file', () => {
    const missing = new P2pChatStore(testFile(), silentLogger);
    missing.load();
    expect(missing.size).toBe(0);

    const damagedFile = testFile();
    writeFileSync(damagedFile, 'not json at all', 'utf8');
    const damaged = new P2pChatStore(damagedFile, silentLogger);
    damaged.load();
    expect(damaged.size).toBe(0);

    const futureFile = testFile();
    writeFileSync(futureFile, JSON.stringify({ version: 99, chats: { ou_a: 'oc_1' } }), 'utf8');
    const future = new P2pChatStore(futureFile, silentLogger);
    future.load();
    expect(future.size).toBe(0);

    const shapelessFile = testFile();
    writeFileSync(shapelessFile, JSON.stringify({ version: 1, chats: null }), 'utf8');
    const shapeless = new P2pChatStore(shapelessFile, silentLogger);
    shapeless.load();
    expect(shapeless.size).toBe(0);
  });

  it('keeps working in memory when the table cannot be written', () => {
    // A directory where the file should be makes every write fail; learning
    // must still hold for this process (a read-only data dir is not fatal).
    const dir = testDir();
    const file = join(dir, 'p2p-chats.json');
    mkdirSync(file, { recursive: true });
    const store = new P2pChatStore(file, silentLogger);
    store.load();
    store.set('ou_a', 'oc_1');
    expect(store.get('ou_a')).toBe('oc_1');
  });
});

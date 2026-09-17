/**
 * Unit tests for the inbound context merge's pure core: which earlier
 * messages one text-less @-mention absorbs.
 */

import { describe, expect, it } from 'vitest';
import {
  type ContextMergeLimits,
  collectContextRun,
  DEFAULT_CONTEXT_MERGE_MAX_MESSAGES,
  DEFAULT_CONTEXT_MERGE_WINDOW_MS,
  isContextWorthy,
} from '../src/context-merge.js';
import type { RecentChatMessage } from '../src/feishu/types.js';

const BASE = 1_700_000_000_000;
const LIMITS: ContextMergeLimits = { maxMessages: 10, windowMs: 10 * 60_000 };

/** One history entry (newest-first input order is built by the callers). */
function entry(
  messageId: string,
  senderOpenId: string,
  text: string,
  at: number,
  extra: Partial<RecentChatMessage> = {},
): RecentChatMessage {
  return {
    messageId,
    senderOpenId,
    senderType: 'user',
    text,
    attachments: [],
    createdAt: at,
    ...extra,
  };
}

/** The trigger at `at` from `ou_rui`. */
function trigger(at: number, extra: Partial<Parameters<typeof collectContextRun>[1]> = {}) {
  return {
    messageId: 'om_trigger',
    senderOpenId: 'ou_rui',
    createdAt: at,
    ...extra,
  };
}

describe('collectContextRun', () => {
  it("collects the sender's immediately preceding messages, oldest first", () => {
    const history = [
      entry('om_trigger', 'ou_rui', '', BASE + 3000),
      entry('om_rui2', 'ou_rui', '小蕊2', BASE + 2000),
      entry('om_rui1', 'ou_rui', '小蕊1', BASE + 1000),
      entry('om_yi1', 'ou_yi', '小义1', BASE),
    ];
    const run = collectContextRun(history, trigger(BASE + 3000), LIMITS);
    expect(run.messages.map((m) => m.text)).toEqual(['小蕊1', '小蕊2']);
    expect(run.droppedCount).toBe(0);
  });

  it('stops at the first message from anybody else', () => {
    const history = [
      entry('om_rui2', 'ou_rui', '小蕊2', BASE + 2000),
      entry('om_other', 'ou_other', 'someone else', BASE + 1500),
      entry('om_rui1', 'ou_rui', '小蕊1', BASE + 1000),
    ];
    const run = collectContextRun(history, trigger(BASE + 3000), LIMITS);
    expect(run.messages.map((m) => m.text)).toEqual(['小蕊2']);
  });

  it("stops at the bot's own message (a bot is just another sender)", () => {
    const history = [
      entry('om_rui2', 'ou_rui', '小蕊2', BASE + 2000),
      entry('om_bot', 'ou_bot', 'the bot replied', BASE + 1500, { senderType: 'app' }),
      entry('om_rui1', 'ou_rui', '小蕊1', BASE + 1000),
    ];
    const run = collectContextRun(history, trigger(BASE + 3000), LIMITS);
    expect(run.messages.map((m) => m.text)).toEqual(['小蕊2']);
  });

  it('stops at the delivery watermark (already delivered context is not repeated)', () => {
    const history = [
      entry('om_rui2', 'ou_rui', '小蕊2', BASE + 2000),
      entry('om_rui1', 'ou_rui', '小蕊1', BASE + 1000),
    ];
    const run = collectContextRun(
      history,
      trigger(BASE + 3000, { deliveredThroughMessageId: 'om_rui2' }),
      LIMITS,
    );
    expect(run.messages).toEqual([]);
  });

  it('keeps the newest messages and counts the ones the limit left out', () => {
    const history = [
      entry('om_r3', 'ou_rui', '3', BASE + 3000),
      entry('om_r2', 'ou_rui', '2', BASE + 2000),
      entry('om_r1', 'ou_rui', '1', BASE + 1000),
    ];
    const run = collectContextRun(history, trigger(BASE + 4000), {
      maxMessages: 2,
      windowMs: LIMITS.windowMs,
    });
    expect(run.messages.map((m) => m.text)).toEqual(['2', '3']);
    expect(run.droppedCount).toBe(1);
  });

  it('counts messages older than the window as dropped, not as absent', () => {
    const history = [
      entry('om_new', 'ou_rui', 'recent', BASE + 4000),
      entry('om_old', 'ou_rui', 'ancient', BASE),
    ];
    const run = collectContextRun(history, trigger(BASE + 5000), {
      maxMessages: LIMITS.maxMessages,
      // 1s window: only 'recent' (1s old) qualifies; 'ancient' is 5s old.
      windowMs: 1_000,
    });
    expect(run.messages.map((m) => m.text)).toEqual(['recent']);
    expect(run.droppedCount).toBe(1);
  });

  it('ignores messages newer than the trigger and the trigger itself', () => {
    const history = [
      entry('om_later', 'ou_rui', 'after the mention', BASE + 9000),
      entry('om_trigger', 'ou_rui', '', BASE + 3000),
      entry('om_rui1', 'ou_rui', '小蕊1', BASE + 1000),
    ];
    const run = collectContextRun(history, trigger(BASE + 3000), LIMITS);
    expect(run.messages.map((m) => m.text)).toEqual(['小蕊1']);
  });

  it('collects nothing without a sender id (an unnamed sender cannot be matched)', () => {
    const history = [entry('om_rui1', '', 'anonymous', BASE)];
    const run = collectContextRun(history, trigger(BASE + 1000, { senderOpenId: '' }), LIMITS);
    expect(run.messages).toEqual([]);
    expect(run.droppedCount).toBe(0);
  });

  it('exports the documented defaults', () => {
    expect(DEFAULT_CONTEXT_MERGE_MAX_MESSAGES).toBe(10);
    expect(DEFAULT_CONTEXT_MERGE_WINDOW_MS).toBe(600_000);
  });
});

describe('isContextWorthy', () => {
  it('keeps text, attachments, recalled and unreadable-type entries', () => {
    expect(isContextWorthy(entry('a', 'ou', 'hello', BASE))).toBe(true);
    expect(
      isContextWorthy(
        entry('b', 'ou', '', BASE, {
          attachments: [{ kind: 'file', key: 'file_v2_x', name: 'notes.txt' }],
        }),
      ),
    ).toBe(true);
    expect(isContextWorthy(entry('c', 'ou', '', BASE, { recalled: true }))).toBe(true);
    expect(isContextWorthy(entry('d', 'ou', '', BASE, { unsupportedType: 'sticker' }))).toBe(true);
  });

  it('skips a content-less bubble (the empty mention that still holds a place)', () => {
    expect(isContextWorthy(entry('a', 'ou', '', BASE))).toBe(false);
    expect(isContextWorthy(entry('b', 'ou', '   ', BASE))).toBe(false);
  });
});

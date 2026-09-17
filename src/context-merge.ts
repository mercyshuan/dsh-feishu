/**
 * Inbound context merge — the pure core.
 *
 * A Feishu user often fires several messages in a row and only @-mentions the
 * bot on the last one (sometimes with an EMPTY body: just the mention). The
 * messages before it never passed the group mention gate, so the agent never
 * saw them — and the mention turn then carries no instruction at all.
 *
 * This module owns the SELECTION half of the fix: given the chat's recent
 * history (newest first) and the trigger message, it returns the sender's
 * immediately preceding run of messages, bounded by a count limit and a time
 * window. It is deliberately pure (no I/O, no formatting) so the rule is
 * unit-testable on its own; the bridge renders the result and the transport
 * fetches the history.
 *
 * @module @dsh-feishu/dsh-feishu/context-merge
 */

import type { RecentChatMessage } from './feishu/types.js';

/** Default cap on how many earlier messages one turn absorbs. */
export const DEFAULT_CONTEXT_MERGE_MAX_MESSAGES = 10;

/** Default look-back window (10 minutes) for the merged run. */
export const DEFAULT_CONTEXT_MERGE_WINDOW_MS = 10 * 60_000;

/** Bounds applied to one context-merge collection. */
export interface ContextMergeLimits {
  /** Keep at most this many earlier messages (the NEWEST ones). */
  readonly maxMessages: number;
  /** Ignore anything older than this many ms before the trigger. */
  readonly windowMs: number;
}

/** The @-mention message whose context is being collected. */
export interface ContextMergeTrigger {
  /** The trigger's own message id (never part of the collected run). */
  readonly messageId: string;
  /** The sender whose preceding messages are collected. */
  readonly senderOpenId: string;
  /** The trigger's arrival time (epoch ms) — the walk's starting point. */
  readonly createdAt: number;
  /**
   * The newest message this chat has already DELIVERED to the agent, if any.
   * The run stops there: older messages are already in the session, so
   * merging them again would duplicate context the agent has read.
   */
  readonly deliveredThroughMessageId?: string;
}

/** The collected run plus its coverage. */
export interface ContextMergeRun {
  /** The kept messages, OLDEST first (the order they are rendered in). */
  readonly messages: readonly RecentChatMessage[];
  /**
   * How many same-sender messages the limits left out. 0 means the run is
   * COMPLETE (everything the sender said before the trigger is here) — a
   * non-zero value must be surfaced, never silently dropped.
   */
  readonly droppedCount: number;
}

/**
 * Select the run of messages from the trigger's sender that immediately
 * precedes it: newest-to-oldest until the first message from anybody else
 * (another member, or the bot itself), the delivery watermark, the count
 * limit, or the time window stops the walk.
 *
 * Stopping at a different sender is the whole point — sweeping up that
 * user's last N messages across other people's replies would splice together
 * a conversation that never happened.
 * @param history - the chat's recent messages, newest first (extra entries,
 *   including ones newer than the trigger, are ignored).
 * @param trigger - the @-mention being delivered.
 * @param limits - the count and window bounds.
 * @returns the collected run (oldest first) and how many were left out.
 */
export function collectContextRun(
  history: readonly RecentChatMessage[],
  trigger: ContextMergeTrigger,
  limits: ContextMergeLimits,
): ContextMergeRun {
  const maxMessages = Math.max(0, Math.floor(limits.maxMessages));
  const windowMs = Math.max(0, limits.windowMs);
  // An empty sender id cannot be matched, and matching it would merge
  // unrelated messages that also arrived without one.
  if (trigger.senderOpenId === '') return { messages: [], droppedCount: 0 };

  const before = history
    .filter(
      (message) =>
        message.messageId !== trigger.messageId && message.createdAt <= trigger.createdAt,
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const run: RecentChatMessage[] = [];
  for (const message of before) {
    if (message.messageId === trigger.deliveredThroughMessageId) break;
    if (message.senderOpenId !== trigger.senderOpenId) break;
    run.push(message);
  }

  const kept = run
    .filter((message) => trigger.createdAt - message.createdAt <= windowMs)
    .slice(0, maxMessages);
  return { messages: [...kept].reverse(), droppedCount: run.length - kept.length };
}

/**
 * Whether one collected message contributes anything to the merged block.
 *
 * A text-less, attachment-less message (the user hit send on a bare mention,
 * or an earlier empty bubble) carries no information — it is skipped when
 * rendering, yet it still occupied its place in the run (it does not break
 * the sender's contiguity).
 * @param message - one message from the collected run.
 * @returns whether it should be rendered into the merged block.
 */
export function isContextWorthy(message: RecentChatMessage): boolean {
  if (message.recalled === true) return true;
  if (message.unsupportedType !== undefined) return true;
  if (message.attachments.length > 0) return true;
  return message.text.trim() !== '';
}

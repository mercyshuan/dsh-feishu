/**
 * Durable open-id → p2p-chat table.
 *
 * A bot custom-menu click (`application.bot.menu_v6`) names the operator and
 * the clicked item's `event_key` — and NOTHING else: the custom menu is
 * p2p-only and the platform sends no chat id with the event. So "which
 * conversation does this click act in" can only be answered from a local table
 * of the conversations this app has already served.
 *
 * The table is learned from inbound p2p traffic (every accepted message
 * records sender → chat) and PERSISTED, because the alternative — relearning
 * it after every restart — makes the first menu click following each restart a
 * silent no-op, which is exactly the failure this seam exists to prevent.
 *
 * Durability rules are shared with the session map: atomic temp-file + rename
 * writes, and a missing / unreadable / damaged / future-versioned file is
 * never an error — it degrades to "nothing learned yet".
 *
 * @module @dsh-feishu/dsh-feishu/p2p-chats
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Durable document shape (v1). */
interface PersistedP2pChats {
  version: 1;
  /** open id → the p2p chat id it was last seen talking in. */
  chats: Record<string, string>;
}

/** The table version this build understands. */
const SUPPORTED_VERSION = 1;

/** Minimal logger surface (`BridgeLogger` satisfies it). */
export interface P2pChatLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/**
 * The learned table. Reads are pure map lookups; a write persists the whole
 * document (it is tiny — one entry per person who ever messaged the bot).
 */
export class P2pChatStore {
  private readonly byUser = new Map<string, string>();
  private loaded = false;

  /**
   * @param file - path of the durable JSON table.
   * @param logger - optional tracing/degradation notices.
   */
  constructor(
    private readonly file: string,
    private readonly logger?: P2pChatLogger,
  ) {}

  /**
   * Load the persisted table once. A missing or unreadable file is a no-op
   * (first run); a damaged one is reported and ignored rather than thrown, so
   * a bad table can never stop the surface from serving messages.
   */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as PersistedP2pChats;
      if (
        parsed.version !== SUPPORTED_VERSION ||
        typeof parsed.chats !== 'object' ||
        parsed.chats === null
      ) {
        this.logger?.warn(`p2p chat table ${this.file}: unsupported shape, starting empty`);
        return;
      }
      for (const [openId, chatId] of Object.entries(parsed.chats)) {
        if (openId !== '' && typeof chatId === 'string' && chatId !== '') {
          this.byUser.set(openId, chatId);
        }
      }
    } catch {
      // Missing file (first run) or unreadable/undecodable content.
    }
    this.logger?.debug(`p2p chat table: loaded ${this.byUser.size} binding(s) from ${this.file}`);
  }

  /**
   * The p2p chat a person was last seen talking in.
   * @param openId - the person's app-scoped open id.
   * @returns the chat id, or `undefined` when nothing has been learned yet.
   */
  get(openId: string): string | undefined {
    return this.byUser.get(openId);
  }

  /**
   * Remember (and persist) a person's p2p chat. Blank values are ignored — a
   * half-learned binding is worse than none, since it would aim a command at
   * the wrong place. A repeated identical binding does not rewrite the file.
   * @param openId - the person's app-scoped open id.
   * @param chatId - the p2p chat id.
   */
  set(openId: string, chatId: string): void {
    if (openId === '' || chatId === '') return;
    if (this.byUser.get(openId) === chatId) return;
    this.byUser.set(openId, chatId);
    this.logger?.debug(`p2p chat table: ${openId} -> ${chatId}`);
    this.persist();
  }

  /** Number of learned bindings. */
  get size(): number {
    return this.byUser.size;
  }

  /**
   * Persist the table atomically (temp file + rename). A failed write is
   * reported but never thrown: the learning still holds in memory for this
   * process, and a read-only data directory must not break message handling.
   */
  private persist(): void {
    const data: PersistedP2pChats = {
      version: SUPPORTED_VERSION,
      chats: Object.fromEntries(this.byUser),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (error: unknown) {
      this.logger?.warn(`p2p chat table write failed: ${String(error)}`);
    }
  }
}

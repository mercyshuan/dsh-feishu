/**
 * Local identity aliases: the open-id → person table the surface resolves
 * before every inbound turn.
 *
 * A Feishu `im.message.receive_v1` event carries a sender's `sender_id`
 * (`ou_…`) and nothing else — no display name — so "who is talking to the
 * agent right now" can only be answered from a LOCAL table an operator (or
 * the agent itself) maintains. This module owns that table and the
 * agent-visible identity block built from one lookup.
 *
 * The table is a small JSON file with the same durability rules as the
 * session map (a versioned document, tolerant reads): a missing, unreadable,
 * damaged, or future-versioned file is NEVER an error — it degrades to "no
 * aliases" so a broken table can never interrupt message delivery. The file
 * is also re-read when its `mtimeMs`/`size` changes, because the agent is
 * expected to REWRITE it mid-conversation (externally) to register a newly
 * confirmed identity; the alias must take effect on the next message without
 * a restart.
 *
 * @module @dsh-feishu/dsh-feishu/identity-aliases
 */

import { readFileSync, statSync } from 'node:fs';

/** The marker line every inbound identity block starts with. */
export const IDENTITY_PREFIX = '[Feishu identity]';

/** One registered person, keyed by their app-scoped Feishu open id. */
export interface IdentityAlias {
  /** The person's full name (the one required field). */
  readonly name: string;
  /** The familiar name ("小义"), shown first when present. */
  readonly nickname?: string;
  /**
   * The person's private knowledge base, injected VERBATIM (never resolved or
   * completed by the surface), so an absolute path is what an operator should
   * write there — it stays correct regardless of the chat's working
   * directory.
   */
  readonly knowledgeBase?: string;
}

/** Minimal logger surface the alias store needs (`BridgeLogger` satisfies it). */
export interface IdentityAliasLogger {
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
  /** Loud, non-fatal degradation notices. */
  warn(message: string): void;
}

/** Durable alias-table document shape (v1). */
interface PersistedAliases {
  version: 1;
  aliases: Record<string, IdentityAlias>;
}

/** The alias-table version this build understands. */
const SUPPORTED_VERSION = 1;

/**
 * Normalize one raw table entry, or reject it. Only a non-empty string `name`
 * makes an entry usable; `nickname` / `knowledgeBase` are optional and a
 * blank value is treated as absent rather than rendered as an empty field.
 * @param value - the raw JSON value for one open id.
 * @returns the normalized alias, or `undefined` when the entry is unusable.
 */
function normalizeAlias(value: unknown): IdentityAlias | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as { name?: unknown; nickname?: unknown; knowledgeBase?: unknown };
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return undefined;
  const nickname =
    typeof raw.nickname === 'string' && raw.nickname.trim() !== '' ? raw.nickname : undefined;
  const knowledgeBase =
    typeof raw.knowledgeBase === 'string' && raw.knowledgeBase.trim() !== ''
      ? raw.knowledgeBase
      : undefined;
  return {
    name: raw.name,
    ...(nickname !== undefined ? { nickname } : {}),
    ...(knowledgeBase !== undefined ? { knowledgeBase } : {}),
  };
}

/**
 * The local open-id → person table, hot-reloaded from its file.
 *
 * Reads are cached by `<mtimeMs>:<size>`, so a message costs one `stat` and no
 * JSON parse while the file is unchanged — and the very next message after an
 * external rewrite sees the new table. Every failure mode (absent file,
 * unreadable content, invalid JSON, unknown version, unusable entries)
 * degrades to an empty table with a `debug`/`warn` line and never throws.
 */
export class IdentityAliasStore {
  /** The table currently in memory (empty = "no aliases registered"). */
  private table: Record<string, IdentityAlias> = {};
  /** Cache key (`<mtimeMs>:<size>`) of {@link table}; `null` = never read,
   *  `undefined` = the file was absent when last checked. */
  private cacheKey: string | undefined | null = null;

  /**
   * @param file - absolute path of the durable alias-table JSON file.
   * @param logger - optional logger for hot-reload and degradation tracing.
   */
  constructor(
    private readonly file: string,
    private readonly logger?: IdentityAliasLogger,
  ) {}

  /**
   * The alias file this store resolves against — quoted verbatim in the
   * "unknown sender" hint so the agent knows where to register a person.
   * @returns the absolute alias-table path.
   */
  path(): string {
    return this.file;
  }

  /**
   * The person registered for one sender open id.
   * @param openId - the inbound message's `senderOpenId`.
   * @returns the alias, or `undefined` when this open id is not registered.
   */
  lookup(openId: string): IdentityAlias | undefined {
    return this.current()[openId];
  }

  /**
   * The number of registered aliases in the currently loaded table (diagnostic
   * and test seam).
   * @returns the alias count.
   */
  get size(): number {
    return Object.keys(this.current()).length;
  }

  /**
   * The current table, re-read only when the file's identity changed.
   * @returns the in-memory alias table.
   */
  private current(): Record<string, IdentityAlias> {
    const key = this.fileKey();
    if (key === this.cacheKey) return this.table;
    this.cacheKey = key;
    this.table = key === undefined ? {} : this.readTable(key);
    return this.table;
  }

  /**
   * The file's cache key: `<mtimeMs>:<size>`, or `undefined` when the file is
   * absent/unreadable. Size is part of the key because a coarse mtime
   * resolution (FAT, some VM mounts) can leave `mtimeMs` unchanged across two
   * writes an agent makes inside the same tick.
   * @returns the cache key, or `undefined` when the file does not exist.
   */
  private fileKey(): string | undefined {
    try {
      const stat = statSync(this.file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse the alias file. Never throws: every problem degrades to an empty
   * table plus a log line.
   * @param key - the cache key the file was read under (for the debug trace).
   * @returns the parsed table, or an empty object when it is unusable.
   */
  private readTable(key: string): Record<string, IdentityAlias> {
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (error: unknown) {
      this.logger?.warn(
        `identity aliases: cannot read ${this.file} (${key}): ${String(error)} — using an empty table`,
      );
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      this.logger?.warn(
        `identity aliases: ${this.file} is not valid JSON: ${String(error)} — using an empty table`,
      );
      return {};
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.logger?.warn(
        `identity aliases: ${this.file} is not an alias document — using an empty table`,
      );
      return {};
    }
    const document = parsed as { version?: unknown; aliases?: unknown };
    if (document.version !== SUPPORTED_VERSION) {
      this.logger?.warn(
        `identity aliases: ${this.file} has unsupported version ${String(document.version)} ` +
          `(expected ${SUPPORTED_VERSION}) — using an empty table`,
      );
      return {};
    }
    if (typeof document.aliases !== 'object' || document.aliases === null) {
      this.logger?.warn(
        `identity aliases: ${this.file} has no "aliases" object — using an empty table`,
      );
      return {};
    }
    const table: Record<string, IdentityAlias> = {};
    for (const [openId, value] of Object.entries(document.aliases)) {
      const alias = normalizeAlias(value);
      if (alias === undefined) {
        // One unusable entry is dropped alone; the rest of the table still
        // resolves (a hand-edited file must not blank every identity).
        this.logger?.warn(
          `identity aliases: entry ${openId} in ${this.file} has no usable "name" — ignored`,
        );
        continue;
      }
      table[openId] = alias;
    }
    this.logger?.debug(
      `identity aliases: loaded ${Object.keys(table).length} alias(es) from ${this.file} (${key})`,
    );
    return table;
  }
}

/** The inputs one inbound identity block is built from. */
export interface IdentityBlockInput {
  /** The inbound message's sender open id (`ou_…`). */
  readonly senderOpenId: string;
  /** The chat the message arrived in (`oc_…`). */
  readonly chatId: string;
  /** `p2p` (direct message) or `group`. */
  readonly chatType: 'p2p' | 'group';
  /** The alias registered for the sender, or `undefined` when unknown. */
  readonly alias: IdentityAlias | undefined;
  /** Absolute path of the alias table (the unknown-sender hint quotes it). */
  readonly aliasesFile: string;
}

/**
 * Build the agent-visible identity block for one inbound message.
 *
 * Line 1 is the machine-readable fact line; line 2 is the standing
 * instruction that turns it into behavior. Both the registered and the
 * not-yet-registered sender get a block — an unknown sender must be told
 * apart from a mis-resolved one, and the hint tells the agent where the
 * registration goes.
 * @param input - the sender, the chat, the resolved alias, and the table path.
 * @returns the block text (two lines; never empty).
 */
export function identityBlockText(input: IdentityBlockInput): string {
  const kind = input.chatType === 'group' ? '群聊' : '私聊';
  const location = `sender_open_id=${input.senderOpenId} · chat=${input.chatId} · 类型：${kind}`;
  const alias = input.alias;
  if (alias === undefined) {
    return [
      `${IDENTITY_PREFIX} 未知发件人 · ${location}`,
      `（这是本次请求的发送者身份，但尚未登记姓名；在依赖身份作答前先向对方确认，并提示把结果登记到别名表文件：${input.aliasesFile}。）`,
    ].join('\n');
  }
  const who = alias.nickname === undefined ? alias.name : `${alias.nickname}（${alias.name}）`;
  const knowledgeBase = alias.knowledgeBase === undefined ? '' : `· 知识库：${alias.knowledgeBase}`;
  return [
    `${IDENTITY_PREFIX} 当前对话对象：${who}${knowledgeBase} · ${location}`,
    '（这是本次请求的发送者身份；按其身份作答，关于此人的个人信息只读写其知识库。）',
  ].join('\n');
}

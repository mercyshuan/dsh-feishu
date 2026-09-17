/**
 * Feishu (Lark) transport over the official `@larksuiteoapi/node-sdk`.
 *
 * Two connections share the app credentials:
 * - a `WSClient` long connection (outbound only — no public endpoint, no
 *   public IP needed on the host) that delivers `im.message.receive_v1`
 *   events and, later, card action callbacks; and
 * - a `Client` used for outbound API calls (`message.create` /
 *   `message.patch`).
 *
 * The SDK resolves `{code, msg, data}` responses without throwing on
 * business errors, so every call asserts `code === 0` and throws a
 * {@link FeishuApiError} otherwise.
 *
 * @module @dsh-feishu/dsh-feishu/transport
 */

import { PassThrough } from 'node:stream';
import {
  Client,
  EventDispatcher,
  type HttpInstance,
  type RawCardActionEvent,
  type RawMessageEvent,
  WSClient,
} from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import type {
  CardAction,
  CardJson,
  ChatStats,
  FeishuMessage,
  FeishuTransport,
  InboundAttachment,
  QuotedMessage,
  RecentChatMessage,
  SentCard,
} from './feishu/types.js';
import { serializePost } from './rich-text.js';

/**
 * The HTTP instance the SDK's `Client` and `WSClient` use for every Feishu
 * call (REST + WS endpoint discovery).
 *
 * Two things the SDK's own `defaultHttpInstance` does that a bare axios
 * instance does not:
 * - its response interceptor unwraps `resp.data` (the JSON body) so
 *   `request()` resolves to `{code, data, msg}` — the SDK's callers
 *   destructure those fields directly (WS endpoint discovery fails with
 *   `code: undefined` otherwise); and
 * - the proxy: the default instance honors `http_proxy`/`https_proxy` env
 *   vars, which breaks both flows behind a proxy — follow-redirects dies
 *   with `Protocol "https:" not supported. Expected "http:"` (user report).
 *   Feishu is reached directly, so the proxy is disabled here.
 *
 * Both are mirrored below so this instance is a drop-in replacement.
 */
export const FEISHU_HTTP = axios.create({ proxy: false });
FEISHU_HTTP.interceptors.request.use(
  (req) => {
    if (req.headers && !req.headers['User-Agent']) req.headers['User-Agent'] = 'dsh-feishu';
    return req;
  },
  undefined,
  { synchronous: true },
);
FEISHU_HTTP.interceptors.response.use((resp) => {
  if ((resp.config as unknown as { $return_headers?: boolean }).$return_headers) {
    return { data: resp.data, headers: resp.headers };
  }
  return resp.data;
});

/** Minimal logger surface the transport needs. */
export interface TransportLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
}

/**
 * The SDK's `Client.request` payload type, plus the `$return_headers` flag
 * the SDK's own generated download code passes (its public types omit it).
 */
type SdkRequestPayload = Parameters<Client['request']>[0] & { $return_headers?: boolean };

/** Credentials for the Feishu app. */
export interface LarkCredentials {
  readonly appId: string;
  readonly appSecret: string;
}

/** Options for {@link LarkTransport}. */
export interface LarkTransportOptions {
  readonly credentials: LarkCredentials;
  readonly logger?: TransportLogger;
}

/** A failed Feishu API call (non-zero `code`). */
export class FeishuApiError extends Error {
  readonly operation: string;
  readonly code: number;

  constructor(operation: string, code: number, message: string) {
    super(`feishu ${operation} failed: ${message} (code ${code})`);
    this.name = 'FeishuApiError';
    this.operation = operation;
    this.code = code;
  }
}

/** Strip `<at …>name</at>` mention placeholders from Feishu text content. */
const MENTION_PATTERN = /<at[^>]*>.*?<\/at>/g;

/** Message types the surface understands; everything else is ignored. */
const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image', 'file', 'post', 'video', 'audio']);

/**
 * Feishu `message_type` values the platform defines but this surface does
 * NOT handle. Instead of silently dropping them (a user sending a folder or
 * sticker would get zero feedback), they normalize into a message carrying
 * `unsupportedType` so the bridge can reply with a loud notice. Unknown
 * types (not in this set either) stay ignored — no invented feedback.
 */
const KNOWN_UNSUPPORTED_MESSAGE_TYPES = new Set([
  'folder',
  'sticker',
  'share_chat',
  'share_user',
  'system',
  'media',
  'merge',
  'interactive',
]);

/** Platform page cap for `im.v1.message.list` (`page_size` max is 50). */
const MAX_HISTORY_PAGE = 50;

/** Parse an image/file message's content JSON into its attachment, or
 *  `undefined` when the content is malformed. */
function parseAttachment(content: string, messageType: string): InboundAttachment | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, string>;
    if (messageType === 'image') {
      const key = parsed.image_key;
      if (typeof key === 'string' && key !== '') return { kind: 'image', key };
      return undefined;
    }
    const key = parsed.file_key;
    if (typeof key === 'string' && key !== '') {
      const name = parsed.file_name;
      return { kind: 'file', key, ...(typeof name === 'string' && name !== '' ? { name } : {}) };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse one message body (`message_type` + raw `content` JSON) into the
 * surface's text + attachment view. Shared by the live inbound message and a
 * quoted (replied-to) message read back through `im.v1.message.get`, so both
 * speak the same vocabulary (ordered `<image N>` placeholders, attachment
 * list, mention stripping). Pure function — unit-testable without any SDK
 * connection.
 * @param messageType - the Feishu `message_type`.
 * @param content - the raw `content` JSON string.
 * @returns the parsed text + attachments, or `undefined` when a supported
 *   type carries a malformed body (the raw JSON is never delivered as text).
 */
export function parseMessageBody(
  messageType: string,
  content: string,
): { text: string; attachments: InboundAttachment[] } | undefined {
  if (messageType === 'text') {
    let text: string;
    try {
      const parsed = JSON.parse(content) as { text?: string };
      text = parsed.text ?? '';
    } catch {
      return undefined;
    }
    return {
      text: text.replace(MENTION_PATTERN, ' ').replace(/\s+/g, ' ').trim(),
      attachments: [],
    };
  }
  if (messageType === 'post') {
    // Rich text: serialize the inline element order into a markdown-ish
    // string with `<image N>` / `<video N>` placeholders, plus the ordered
    // attachment list. Malformed content degrades to a loud-ignored message.
    const serialized = serializePost(content);
    if (serialized === undefined) return undefined;
    return { text: serialized.text, attachments: [...serialized.attachments] };
  }
  const attachment = parseAttachment(content, messageType);
  // A malformed image/file content (no key) is not a usable body.
  if (attachment === undefined) return undefined;
  return { text: '', attachments: [attachment] };
}

/**
 * Normalize a raw Feishu `im.message.receive_v1` payload into a surface
 * message, or `undefined` when the message is not a supported type.
 * Pure function — unit-testable without any SDK connection.
 *
 * A reply/quote carries only its parent's id in the event; this function
 * records that id as `quotedMessageId` and leaves the body resolution to the
 * transport (which owns the API call).
 * @param data - the raw event payload.
 * @returns the normalized message, or `undefined` to ignore.
 */
export function normalizeMessageEvent(data: RawMessageEvent): FeishuMessage | undefined {
  const message = data.message;
  const senderOpenId = data.sender?.sender_id?.open_id ?? '';
  const parentId = (message as { readonly parent_id?: unknown }).parent_id;
  const quotedMessageId =
    typeof parentId === 'string' && parentId !== '' ? { quotedMessageId: parentId } : {};
  if (!SUPPORTED_MESSAGE_TYPES.has(message.message_type)) {
    // A known-but-unhandled Feishu type (folder, sticker, …) is surfaced as
    // an unsupported-type notice instead of vanishing; unknown types are
    // still ignored.
    if (KNOWN_UNSUPPORTED_MESSAGE_TYPES.has(message.message_type)) {
      return {
        messageId: message.message_id,
        chatId: message.chat_id,
        chatType: message.chat_type === 'group' ? 'group' : 'p2p',
        senderOpenId,
        text: '',
        attachments: [],
        mentions: [],
        unsupportedType: message.message_type,
        ...quotedMessageId,
        createdAt: Number(message.create_time) || Date.now(),
      };
    }
    return undefined;
  }
  const body = parseMessageBody(message.message_type, message.content);
  if (body === undefined) return undefined;
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    senderOpenId,
    text: body.text,
    attachments: body.attachments,
    mentions: (message.mentions ?? [])
      .map((mention) => mention.id?.open_id)
      .filter((id): id is string => id !== undefined && id !== ''),
    ...quotedMessageId,
    createdAt: Number(message.create_time) || Date.now(),
  };
}

/**
 * Normalize an `im.v1.message.get` response into the quoted-message view the
 * bridge renders into the turn's content. Pure function — unit-testable
 * without any SDK connection.
 *
 * Failure is DATA, not an exception: a quote the bot cannot read (recalled
 * message, missing scope, unsupported card body) still returns a
 * {@link QuotedMessage} with `unavailable` set, because the user's explicit
 * quote must reach the agent as "there was a quote I could not read" instead
 * of vanishing.
 * @param response - the parsed response body (`{code, msg, data:{items}}`).
 * @param messageId - the quoted message's id (echoed on the result).
 * @returns the quoted message's text + attachments, or the failure reason.
 */
export function normalizeQuotedMessage(response: unknown, messageId: string): QuotedMessage {
  const unavailable = (reason: string): QuotedMessage => ({
    messageId,
    senderOpenId: '',
    text: '',
    attachments: [],
    unavailable: reason,
  });
  const body = response as {
    code?: number;
    msg?: string;
    data?: { items?: readonly unknown[] };
  } | null;
  const code = body?.code ?? -1;
  if (code !== 0) {
    return unavailable(
      `feishu im.v1.message.get failed: ${body?.msg ?? 'unknown error'} (code ${code})`,
    );
  }
  const item = body?.data?.items?.[0] as
    | {
        msg_type?: string;
        body?: { content?: string };
        sender?: { id?: string };
        deleted?: boolean;
      }
    | undefined;
  if (item === undefined) {
    return unavailable(
      'the quoted message is not readable (recalled, or the bot has no access to it)',
    );
  }
  if (item.deleted === true) return unavailable('the quoted message was recalled');
  const messageType = item.msg_type ?? '';
  const senderOpenId = item.sender?.id ?? '';
  if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) {
    // Known-but-unhandled (interactive card, sticker, …) and unknown types
    // alike: report the TYPE, never the raw body (a card's JSON is not text).
    return {
      messageId,
      senderOpenId,
      text: '',
      attachments: [],
      unsupportedType: messageType === '' ? 'unknown' : messageType,
    };
  }
  const parsed = parseMessageBody(messageType, item.body?.content ?? '');
  if (parsed === undefined) {
    return unavailable(`the quoted ${messageType} message's body could not be parsed`);
  }
  return { messageId, senderOpenId, text: parsed.text, attachments: parsed.attachments };
}

/**
 * Normalize one `im.v1.message.list` item into the surface's earlier-message
 * view (inbound-context-merge). Pure function — unit-testable without any SDK
 * connection.
 *
 * Unlike a quoted message, a history item that cannot be rendered is NOT a
 * failure to report: it is just one entry of a conversation, and the caller
 * only needs to know WHAT it was so the run stays honest about it. Recalled
 * and known-but-unhandled entries therefore keep their place with their
 * `recalled` / `unsupportedType` marker rather than becoming `undefined`.
 * @param item - one raw history item.
 * @returns the normalized message, or `undefined` when it carries no id.
 */
export function normalizeRecentMessage(item: unknown): RecentChatMessage | undefined {
  const entry = item as
    | {
        message_id?: string;
        msg_type?: string;
        create_time?: string;
        deleted?: boolean;
        sender?: { id?: string; sender_type?: string };
        body?: { content?: string };
      }
    | null
    | undefined;
  const messageId = entry?.message_id;
  if (messageId === undefined || messageId === '') return undefined;
  const createdAt = Number(entry?.create_time);
  const base = {
    messageId,
    senderOpenId: entry?.sender?.id ?? '',
    senderType: entry?.sender?.sender_type ?? '',
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
  if (entry?.deleted === true) {
    return { ...base, text: '', attachments: [], recalled: true };
  }
  const messageType = entry?.msg_type ?? '';
  if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) {
    // Report the TYPE only — a card's JSON is not text.
    return {
      ...base,
      text: '',
      attachments: [],
      unsupportedType: messageType === '' ? 'unknown' : messageType,
    };
  }
  const parsed = parseMessageBody(messageType, entry?.body?.content ?? '');
  if (parsed === undefined) {
    return { ...base, text: '', attachments: [], unsupportedType: messageType };
  }
  return { ...base, text: parsed.text, attachments: parsed.attachments };
}

/**
 * Parse the bot's own open id out of a `bot/v3/info` response. The current
 * API nests it under `bot.open_id`; the legacy shape put it under
 * `data.open_id`. Reading only one of the two silently disables the group
 * mention gate (every @-mention looks like a plain message). Pure function —
 * unit-testable without any SDK connection.
 * @param response - the parsed `bot/v3/info` body (code must already be 0).
 * @returns the bot's open id, or `undefined` when the body carries none.
 */
export function parseBotOpenId(response: unknown): string | undefined {
  const body = response as { bot?: { open_id?: string }; data?: { open_id?: string } };
  const openId = body.bot?.open_id ?? body.data?.open_id;
  return openId !== undefined && openId !== '' ? openId : undefined;
}

/**
 * Normalize a raw `card.action.trigger` payload into a surface action, or
 * `undefined` when no actionable payload is present. Message/chat ids may be
 * nested under `context` (current v2 shape) or at the root (fallback).
 * Pure function — unit-testable without any SDK connection.
 * @param data - the raw card callback payload.
 * @returns the normalized action, or `undefined` to ignore.
 */
export function normalizeCardAction(data: RawCardActionEvent): CardAction | undefined {
  const messageId = data.context?.open_message_id ?? data.open_message_id;
  const chatId = data.context?.open_chat_id ?? data.open_chat_id;
  const operatorOpenId = data.operator?.open_id ?? '';
  const value = data.action?.value;
  if (
    messageId === undefined ||
    chatId === undefined ||
    typeof value !== 'object' ||
    value === null
  ) {
    return undefined;
  }
  const rawForm = (data.action as { form_value?: unknown } | undefined)?.form_value;
  const formValue =
    typeof rawForm === 'object' && rawForm !== null
      ? (rawForm as Record<string, string>)
      : undefined;
  const option = data.action?.option;
  return {
    messageId,
    chatId,
    operatorOpenId,
    value: value as Record<string, string>,
    ...(option !== undefined ? { option } : {}),
    ...(formValue !== undefined ? { formValue } : {}),
  };
}

/**
 * The Feishu transport: long-connection receive + API send/update.
 */
export class LarkTransport implements FeishuTransport {
  /**
   * Backoff schedule for the bot open id lookup (ms). The lookup can fail for
   * reasons that clear on their own — an auto-start service runs before the
   * network stack is up, so `open.feishu.cn` is briefly unresolvable
   * (`getaddrinfo ENOTFOUND`). The schedule is bounded so a lookup that is
   * broken for another reason stops issuing requests instead of retrying
   * forever.
   */
  private static readonly BOT_OPEN_ID_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

  private readonly client: Client;
  private readonly ws: WSClient;
  private readonly dispatcher = new EventDispatcher({});
  private handler: ((message: FeishuMessage) => void) | undefined;
  private actionHandler: ((action: CardAction) => void) | undefined;
  private readonly logger: TransportLogger | undefined;
  private botOpenIdValue: string | undefined;
  /** Bot-open-id bookkeeping: attempts spent, in-flight call, pending retry. */
  private botOpenIdAttempts = 0;
  private botOpenIdPending: Promise<void> | undefined;
  private botOpenIdRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly statsCache = new Map<string, { stats: ChatStats; at: number }>();
  /** Live long-connection state, maintained by the WSClient callbacks. */
  private connectionStateValue: 'ready' | 'reconnecting' | 'error' = 'reconnecting';

  constructor(options: LarkTransportOptions) {
    const { appId, appSecret } = options.credentials;
    this.logger = options.logger;
    // axios's overloaded `request` doesn't satisfy the SDK's structural
    // `HttpInstance` statically (the SDK's own default is an AxiosInstance,
    // so the cast is safe at runtime).
    const httpInstance = FEISHU_HTTP as unknown as HttpInstance;
    this.client = new Client({ appId, appSecret, httpInstance });
    this.ws = new WSClient({
      appId,
      appSecret,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      httpInstance,
      onReady: () => {
        this.connectionStateValue = 'ready';
        this.logger?.info('feishu long connection ready');
        this.logger?.debug('transport ws state -> ready');
        // A live long connection proves the network is up, which is exactly
        // what the bot open id lookup needs: retry it here so a start-up that
        // lost the race against DNS heals as soon as the link is usable.
        this.ensureBotOpenId();
      },
      onError: (error) => {
        this.connectionStateValue = 'error';
        this.logger?.error(`feishu long connection failed: ${error.message}`);
        this.logger?.debug(`transport ws state -> error: ${error.message}`);
      },
      onReconnecting: () => {
        this.connectionStateValue = 'reconnecting';
        this.logger?.warn('feishu long connection reconnecting');
        this.logger?.debug('transport ws state -> reconnecting');
      },
      onReconnected: () => {
        this.connectionStateValue = 'ready';
        this.logger?.info('feishu long connection reconnected');
        this.logger?.debug('transport ws state -> ready (reconnected)');
      },
    });
  }

  /** The live long-connection state for the `/feishu-status` diagnostic. */
  connectionState(): 'ready' | 'reconnecting' | 'error' {
    return this.connectionStateValue;
  }

  /** Connect the long connection and begin delivering messages. */
  async start(): Promise<void> {
    this.dispatcher.register({
      'im.message.receive_v1': (data) => {
        const message = normalizeMessageEvent(data as RawMessageEvent);
        if (message !== undefined) void this.deliverInbound(message);
        return undefined;
      },
      'card.action.trigger': (data: RawCardActionEvent) => {
        const action = normalizeCardAction(data);
        if (action !== undefined) this.actionHandler?.(action);
        else {
          // A callback we cannot normalize used to vanish without a trace — the
          // user sees "the button does nothing" and the log is empty. The
          // classic cause is a Card 2.0 button carrying the 1.0-style top-level
          // `value`: JSON 2.0 returns `action.value` only for
          // `behaviors:[{type:'callback'}]`, so the payload arrives with no
          // `value` object. Log the raw event so the cause is visible.
          this.logger?.warn(
            `card.action.trigger ignored (no actionable payload): ${JSON.stringify(data).slice(0, 1200)}`,
          );
        }
        // ACK with no UI update. Returning undefined produces a code-only
        // response the Feishu client rejects as an invalid ACK (botmux
        // lesson: the client can then re-render the card to a stale state —
        // exactly the "card reverted to working after opening details" bug).
        return {};
      },
    });
    await this.ws.start({ eventDispatcher: this.dispatcher });
    // Resolve the bot's own open id once the connection is up; the group
    // mention gate needs it to tell "the bot was mentioned" apart from
    // "someone else was mentioned". Retried (and re-attempted on every
    // long-connection ready) because one failed lookup must not disable that
    // gate for the lifetime of the process.
    this.ensureBotOpenId();
  }

  /**
   * Deliver one normalized inbound message to the surface.
   *
   * A reply/quote is resolved FIRST: the event carries only the parent's id,
   * so the quoted body needs a second read — and the user's quoted content is
   * part of the request, so it must be in hand before the turn starts. A
   * plain message is handed over synchronously (no await), so bursts of bare
   * attachment messages keep their arrival order.
   * @param message - the normalized inbound message.
   */
  private async deliverInbound(message: FeishuMessage): Promise<void> {
    const parentId = message.quotedMessageId;
    if (parentId === undefined) {
      this.handler?.(message);
      return;
    }
    const quoted = await this.resolveQuotedMessage(parentId);
    this.handler?.({ ...message, quoted });
  }

  /**
   * Read a reply/quote's parent message into agent-visible content
   * (`im.v1.message.get`). Never throws: an unreadable quote degrades to
   * `unavailable` with its reason, so the agent learns there WAS a quote
   * instead of the quote vanishing.
   * @param messageId - the quoted (parent) message's id.
   * @returns the quoted content, or the failure reason.
   */
  private async resolveQuotedMessage(messageId: string): Promise<QuotedMessage> {
    try {
      const response = await this.client.im.v1.message.get({
        path: { message_id: messageId },
        params: { user_id_type: 'open_id' },
      });
      this.assertOk(response, 'im.v1.message.get');
      const quoted = normalizeQuotedMessage(response, messageId);
      const summary =
        quoted.unavailable ??
        `${quoted.text.length} chars, ${quoted.attachments.length} attachment(s)`;
      this.logger?.debug(`quoted message ${messageId} resolved: ${summary}`);
      return quoted;
    } catch (error: unknown) {
      this.logger?.warn(`quoted message ${messageId} read failed: ${String(error)}`);
      return {
        messageId,
        senderOpenId: '',
        text: '',
        attachments: [],
        unavailable: String(error),
      };
    }
  }

  /**
   * Create a group chat via `im.v1.chat.create`; the given members are
   * invited at creation time and the FIRST member (the requesting user from
   * `/group`) becomes the group owner, so the bot is not the owner.
   * @param name - the group name.
   * @param memberOpenIds - members to invite (open ids).
   * @returns the new chat id.
   */
  async createGroup(name: string, memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    const response = await this.client.im.v1.chat.create({
      data: {
        name,
        user_id_list: [...memberOpenIds],
        ...(memberOpenIds.length > 0 ? { owner_id: memberOpenIds[0] } : {}),
      },
      params: { user_id_type: 'open_id' },
    });
    this.assertOk(response, 'im.v1.chat.create');
    const chatId = response.data?.chat_id;
    if (chatId === undefined) {
      throw new FeishuApiError('im.v1.chat.create', -1, 'response carried no chat_id');
    }
    return { chatId };
  }

  /**
   * Resolve the bot's own open id, retrying with backoff until it lands.
   *
   * The gate in `bridge.ts` compares a group message's `mentions` against
   * this id, so an id that never arrives silently turns every @-mention into
   * "bot not mentioned": the bridge looks alive, holds a healthy long
   * connection, and answers nobody. A single attempt is therefore not enough
   * — an auto-start service can lose the race against the network stack.
   * Concurrent callers share one in-flight lookup, and a success cancels the
   * schedule.
   */
  private ensureBotOpenId(): void {
    if (this.botOpenIdValue !== undefined || this.botOpenIdPending !== undefined) return;
    this.botOpenIdPending = this.resolveBotOpenId()
      .then(() => {
        this.botOpenIdAttempts = 0;
        this.clearBotOpenIdRetry();
      })
      .catch((error: unknown) => {
        this.botOpenIdAttempts += 1;
        this.logger?.warn(
          `bot open id resolution failed (attempt ${this.botOpenIdAttempts}): ${String(error)}`,
        );
        this.scheduleBotOpenIdRetry();
      })
      .finally(() => {
        this.botOpenIdPending = undefined;
      });
  }

  /** Queue the next bot-open-id attempt, or give up once the schedule is spent. */
  private scheduleBotOpenIdRetry(): void {
    if (this.botOpenIdRetryTimer !== undefined) return;
    const delays = LarkTransport.BOT_OPEN_ID_RETRY_DELAYS_MS;
    if (this.botOpenIdAttempts > delays.length) {
      this.logger?.warn(
        'bot open id still unresolved after every retry — the group mention gate stays disabled until the bridge restarts',
      );
      return;
    }
    const delay = delays[Math.min(this.botOpenIdAttempts, delays.length) - 1] ?? 60_000;
    const timer = setTimeout(() => {
      this.botOpenIdRetryTimer = undefined;
      this.ensureBotOpenId();
    }, delay);
    // Never keep the process alive on a retry: a bare `dsh --profile feishu`
    // run must still exit once its surface goes away.
    if (typeof timer.unref === 'function') timer.unref();
    this.botOpenIdRetryTimer = timer;
  }

  /** Cancel a pending bot-open-id retry (lookup succeeded, or transport stopped). */
  private clearBotOpenIdRetry(): void {
    if (this.botOpenIdRetryTimer === undefined) return;
    clearTimeout(this.botOpenIdRetryTimer);
    this.botOpenIdRetryTimer = undefined;
  }

  /** Fetch and cache the bot's own open id (`bot/v3/info`). */
  private async resolveBotOpenId(): Promise<void> {
    const response = await this.client.request<unknown>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    const code = (response as { code?: number })?.code ?? -1;
    if (code !== 0) {
      throw new FeishuApiError(
        'bot.v3.info',
        code,
        (response as { msg?: string })?.msg ?? 'unknown error',
      );
    }
    const openId = parseBotOpenId(response);
    if (openId !== undefined) {
      this.botOpenIdValue = openId;
      // Info (not debug): whether the mention gate is armed is the difference
      // between a working bridge and one that silently ignores every group
      // @-mention, so it belongs in the default log and in health checks.
      this.logger?.info(`bot open id resolved: ${openId}`);
    } else {
      // Fail loud: the group mention gate needs the bot's own open id to tell
      // "the bot was mentioned" apart from "someone else was mentioned". A
      // bot whose id cannot be resolved leaves every group @-mention looking
      // like a plain message under `always`/`topic` modes.
      this.logger?.warn(
        'bot/v3/info succeeded but carried no bot open id — group mention detection is disabled',
      );
    }
  }

  /** The bot's own open id, or `undefined` until resolved. */
  getBotOpenId(): string | undefined {
    return this.botOpenIdValue;
  }

  /**
   * Read a chat's recent history, newest first (`im.v1.message.list`).
   *
   * The surface's own inbound buffer covers the common case; this is the
   * fallback for a run it never saw (a fresh process, or history older than
   * the buffer's cap). One platform page is enough: the collected run starts
   * at the trigger and walks backwards, so anything beyond the newest page
   * could never be contiguous anyway.
   * @param chatId - the chat to read.
   * @param options - the window (epoch ms) and the maximum entries to return.
   * @returns the normalized messages newest-first, or `undefined` when the
   *   read failed (the caller degrades loudly and the turn still runs).
   */
  async listRecentMessages(
    chatId: string,
    options: { since: number; until: number; max: number },
  ): Promise<readonly RecentChatMessage[] | undefined> {
    const pageSize = Math.min(Math.max(Math.floor(options.max), 1), MAX_HISTORY_PAGE);
    try {
      const response = await this.client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          // The platform takes SECONDS; the surface speaks epoch ms.
          start_time: String(Math.floor(options.since / 1000)),
          end_time: String(Math.floor(options.until / 1000)),
          sort_type: 'ByCreateTimeDesc',
          page_size: pageSize,
        },
      });
      this.assertOk(response, 'im.v1.message.list');
      const items = response.data?.items ?? [];
      const messages = items
        .map((item) => normalizeRecentMessage(item))
        .filter((message): message is RecentChatMessage => message !== undefined);
      this.logger?.debug(
        `chat history ${chatId}: ${messages.length} message(s) in window (page_size ${pageSize})`,
      );
      return messages;
    } catch (error: unknown) {
      this.logger?.warn(`chat history read failed (chat ${chatId}): ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Membership counts for a chat, cached for 5 minutes (`im.v1.chat.get`).
   * @param chatId - the chat id.
   * @returns counts, or `undefined` when the API is unavailable.
   */
  async chatStats(chatId: string): Promise<ChatStats | undefined> {
    const cached = this.statsCache.get(chatId);
    if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.stats;
    try {
      const response = await this.client.im.v1.chat.get({ path: { chat_id: chatId } });
      const code = response.code ?? -1;
      if (code !== 0) return undefined;
      const userCount = Number(response.data?.user_count);
      const botCount = Number(response.data?.bot_count);
      if (!Number.isFinite(userCount) || !Number.isFinite(botCount)) return undefined;
      const stats: ChatStats = { userCount, botCount };
      this.statsCache.set(chatId, { stats, at: Date.now() });
      return stats;
    } catch {
      return undefined;
    }
  }

  /** Disconnect the long connection. */
  async stop(): Promise<void> {
    this.clearBotOpenIdRetry();
    this.ws.close();
  }

  /** Register the single inbound-message handler (last registration wins). */
  onMessage(handler: (message: FeishuMessage) => void): void {
    this.handler = handler;
  }

  /** Register the single card-button handler (last registration wins). */
  onCardAction(handler: (action: CardAction) => void): void {
    this.actionHandler = handler;
  }

  /** Send a plain text message to a chat. */
  async sendText(chatId: string, text: string): Promise<void> {
    this.logger?.debug(`transport sendText -> ${chatId}: ${text.slice(0, 80)}`);
    await this.createMessage(chatId, 'text', JSON.stringify({ text }));
  }

  /** Upload a file and deliver it as a file message (`/export`). */
  async sendFile(chatId: string, fileName: string, content: Uint8Array): Promise<void> {
    this.logger?.debug(
      `transport sendFile -> ${chatId}: ${fileName} (${content.byteLength} bytes)`,
    );
    const uploaded = await this.client.im.v1.file.create({
      data: { file_type: 'stream', file_name: fileName, file: Buffer.from(content) },
    });
    // im.v1.file.create returns the data directly (`{file_key} | null`).
    const fileKey = uploaded === null ? undefined : uploaded.file_key;
    if (fileKey === undefined) {
      throw new FeishuApiError('im.v1.file.create', -1, 'response carried no file_key');
    }
    await this.createMessage(chatId, 'file', JSON.stringify({ file_key: fileKey }));
  }

  /** Upload an image (im.v1.image.create) and post it as an image message. */
  async sendImage(chatId: string, fileName: string, bytes: Uint8Array): Promise<void> {
    this.logger?.debug(`transport sendImage -> ${chatId}: ${fileName} (${bytes.byteLength} bytes)`);
    const uploaded = await this.client.im.v1.image.create({
      data: { image_type: 'message', image: Buffer.from(bytes) },
    });
    // im.v1.image.create returns the image_key directly.
    const imageKey = uploaded === null ? undefined : uploaded.image_key;
    if (imageKey === undefined) {
      throw new FeishuApiError('im.v1.image.create', -1, 'response carried no image_key');
    }
    await this.createMessage(chatId, 'image', JSON.stringify({ image_key: imageKey }));
  }

  /** Add an emoji reaction to a message (two-stage ack). */
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    this.logger?.debug(`transport addReaction ${messageId}: ${emojiType}`);
    const response = await this.client.im.v1.messageReaction.create({
      data: { reaction_type: { emoji_type: emojiType } },
      path: { message_id: messageId },
    });
    this.assertOk(response, 'im.v1.message.reaction.create');
    return response.data?.reaction_id;
  }

  /** Remove a reaction previously added by this bot. */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.logger?.debug(`transport removeReaction ${messageId}: ${reactionId}`);
    const response = await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    this.assertOk(response, 'im.v1.message.reaction.delete');
  }

  /** Send an interactive card; resolves with the created message id. */
  async sendCard(chatId: string, card: CardJson): Promise<SentCard> {
    const response = await this.createMessage(chatId, 'interactive', JSON.stringify(card));
    const messageId = response.data?.message_id;
    if (messageId === undefined) {
      throw new FeishuApiError('im.v1.message.create', -1, 'response carried no message_id');
    }
    this.logger?.debug(
      `transport sendCard -> ${chatId}: ${messageId} (${card.header?.title?.content ?? '(no title)'})`,
    );
    return { messageId };
  }

  /** Update an already-sent card in place (silent: no unread notification). */
  async updateCard(messageId: string, card: CardJson): Promise<void> {
    this.logger?.debug(
      `transport updateCard ${messageId}: ${card.header?.title?.content ?? '(no title)'}`,
    );
    const response = await this.client.im.v1.message.patch({
      data: { content: JSON.stringify(card) },
      path: { message_id: messageId },
    });
    this.assertOk(response, 'im.v1.message.patch');
  }

  /** Recall (delete) a previously sent message; never throws (fire-and-forget). */
  async deleteMessage(messageId: string): Promise<void> {
    this.logger?.debug(`transport deleteMessage ${messageId}`);
    try {
      await this.client.im.v1.message.delete({ path: { message_id: messageId } });
    } catch (error: unknown) {
      this.logger?.warn(`message recall failed for ${messageId}: ${String(error)}`);
    }
  }

  /**
   * Download an inbound image message's bytes (`im.v1.image.get`). The image
   * resource endpoint returns the raw raster bytes (not JSON); the declared
   * media type is derived from the message event. Throws on unknown/stale
   * keys or a missing `im:resource` scope.
   */
  /**
   * Download an inbound image message's bytes via the message-resource
   * endpoint (`/messages/{message_id}/resources/{image_key}?type=image`).
   * User-sent images are only reachable here — `im.v1.image.get` can only
   * fetch bot-uploaded images. Routed through the raw client request (not
   * the generated `messageResource.get`, which sends `{}` as a GET body and
   * trips gateway 411s — botmux lesson).
   * @param messageId - the owning message's id.
   * @param key - the normalized `image_key`.
   */
  async downloadImage(
    messageId: string,
    key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    this.logger?.debug(`transport downloadImage ${key} (message ${messageId})`);
    const bytes = await this.downloadMessageResource(messageId, key);
    // The resource endpoint does not echo the media type; default to png —
    // the caller sniffs the real extension from the leading bytes.
    return { data: bytes, mediaType: 'image/png' };
  }

  /**
   * Stream an inbound file message's body via the message-resource endpoint
   * (`/messages/{message_id}/resources/{file_key}?type=file`).
   * User-sent files are only reachable here — `im.v1.file.get` can only
   * fetch bot-uploaded files. Streamed (not buffered) because the resource
   * API serves files up to ~100 MB — the caller pipes the body straight to
   * disk (botmux lesson). The leading bytes are returned separately for type
   * sniffing and pushed back into the stream, so the caller can sniff the
   * extension and still consume the full body.
   * @param messageId - the owning message's id.
   * @param key - the normalized `file_key`.
   */
  async downloadFile(
    messageId: string,
    key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    this.logger?.debug(`transport downloadFile ${key} (message ${messageId})`);
    const response = await this.client.request<{
      data?: NodeJS.ReadableStream;
      headers?: Record<string, string>;
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`,
      params: { type: 'file' },
      responseType: 'stream',
      $return_headers: true,
    } as SdkRequestPayload);
    const stream = response?.data;
    if (stream === undefined) {
      throw new FeishuApiError(
        'im.v1.messageResource.get (file)',
        -1,
        'response carried no resource bytes',
      );
    }
    const contentType = response?.headers?.['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      // A JSON error envelope (e.g. 403 on a withdrawn message) — collect
      // the small body and surface the code instead of persisting it.
      const text = await collectStream(stream);
      const envelope = JSON.parse(text) as { code?: number; msg?: string };
      const code = envelope?.code ?? -1;
      if (code !== 0) {
        throw new FeishuApiError(
          'im.v1.messageResource.get (file)',
          code,
          envelope?.msg ?? 'unknown error',
        );
      }
    }
    // Peek the leading bytes for extension sniffing and relay the full body
    // through a PassThrough (readHead relays; unshift cannot re-arm an ended
    // source stream, and `read(size)` does not truncate Readable.from
    // chunks). The caller's downstream pipe reads the complete body.
    const { stream: relay, head } = await relayHead(stream, 16);
    return { stream: relay, head };
  }

  /**
   * GET one image message resource (`im.v1.messageResource.get`) as bytes.
   *
   * `$return_headers` makes the SDK surface the raw body plus its headers
   * (the SDK's own generated download code does the same). The response
   * interceptor unwraps `resp.data`, so with `responseType: 'arraybuffer'`
   * the body IS the bytes — there is no `{file: ...}` envelope to read.
   * A JSON error envelope (e.g. 403 on a withdrawn message) is detected
   * via the content type and surfaced as a {@link FeishuApiError}, never
   * injected as image bytes.
   */
  private async downloadMessageResource(messageId: string, key: string): Promise<Uint8Array> {
    const response = await this.client.request<{
      data?: Uint8Array | ArrayBuffer;
      headers?: Record<string, string>;
    }>({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`,
      params: { type: 'image' },
      responseType: 'arraybuffer',
      $return_headers: true,
    } as SdkRequestPayload);
    const bytes = response?.data;
    if (bytes === undefined || bytes.byteLength === 0) {
      throw new FeishuApiError(
        'im.v1.messageResource.get (image)',
        -1,
        'response carried no resource bytes',
      );
    }
    const contentType = response?.headers?.['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      const envelope = JSON.parse(new TextDecoder().decode(bytes)) as {
        code?: number;
        msg?: string;
      };
      const code = envelope?.code ?? -1;
      if (code !== 0) {
        throw new FeishuApiError(
          'im.v1.messageResource.get (image)',
          code,
          envelope?.msg ?? 'unknown error',
        );
      }
    }
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  /** Create a message in a chat; assert the API succeeded. */
  private async createMessage(
    chatId: string,
    msgType: string,
    content: string,
  ): Promise<Awaited<ReturnType<Client['im']['v1']['message']['create']>>> {
    const response = await this.client.im.v1.message.create({
      data: { receive_id: chatId, msg_type: msgType, content },
      params: { receive_id_type: 'chat_id' },
    });
    this.assertOk(response, 'im.v1.message.create');
    return response;
  }

  private assertOk(
    response: { code?: number | undefined; msg?: string | undefined },
    operation: string,
  ): void {
    const code = response.code ?? -1;
    if (code !== 0) {
      throw new FeishuApiError(operation, code, response.msg ?? 'unknown error');
    }
  }
}

/** Create a transport for the given credentials. */
export function createLarkTransport(
  credentials: LarkCredentials,
  logger?: TransportLogger,
): FeishuTransport {
  return new LarkTransport({ credentials, ...(logger === undefined ? {} : { logger }) });
}

/**
 * Peek the first `size` bytes of a stream and relay the FULL body through a
 * `PassThrough`, so the caller can sniff the head and still consume every
 * byte downstream.
 *
 * Why not unshift? A source that ends right after one chunk (`Readable.from`
 * with a single element, as tests seed) becomes `readableEnded` once drained,
 * and `unshift` on an ended stream silently drops the data. A relay keeps the
 * head as a copy while the pass-through delivers the body independently of
 * the source's lifecycle.
 *
 * Resolves with fewer than `size` head bytes if the source ends first.
 */
async function relayHead(
  stream: NodeJS.ReadableStream,
  size: number,
): Promise<{ stream: PassThrough; head: Uint8Array }> {
  const relay = new PassThrough();
  const headChunks: Buffer[] = [];
  let headTotal = 0;
  // Forward every chunk into the relay while stashing the leading bytes.
  stream.on('data', (chunk: Buffer) => {
    if (headTotal < size) {
      const want = size - headTotal;
      headChunks.push(chunk.length > want ? chunk.subarray(0, want) : chunk);
      headTotal += Math.min(chunk.length, want);
    }
    relay.write(chunk);
  });
  stream.on('end', () => relay.end());
  stream.on('error', (error: Error) => relay.destroy(error));
  // Wait until the head is filled or the source is done.
  await new Promise<void>((resolve) => {
    if (headTotal >= size) return resolve();
    stream.once('end', resolve);
    stream.once('error', () => resolve());
  });
  return { stream: relay, head: new Uint8Array(Buffer.concat(headChunks)) };
}

/** Concatenate byte chunks into one Uint8Array. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Collect an entire stream's bytes as a UTF-8 string (error envelopes only). */
async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

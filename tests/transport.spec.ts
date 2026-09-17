/**
 * Unit tests for the Feishu transport: message normalization and API error
 * handling. No network: the normalization is a pure function and the error
 * path is exercised through a fake SDK surface.
 */

import { Readable } from 'node:stream';
import type { RawMessageEvent } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { FeishuMessage } from '../src/feishu/types.js';
import {
  FEISHU_HTTP,
  FeishuApiError,
  LarkTransport,
  normalizeCardAction,
  normalizeMessageEvent,
  normalizeQuotedMessage,
  parseBotOpenId,
  parseMessageBody,
} from '../src/transport.js';

/** A minimal raw event with the fields the normalizer reads. */
function rawEvent(
  overrides: {
    sender?: Partial<RawMessageEvent['sender']>;
    message?: Partial<RawMessageEvent['message']>;
  } = {},
): RawMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, ...overrides.sender },
    message: {
      message_id: 'om_msg1',
      create_time: '1700000000000',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
      ...overrides.message,
    },
  } as RawMessageEvent;
}

describe('normalizeMessageEvent', () => {
  it('normalizes a p2p text message', () => {
    const message = normalizeMessageEvent(rawEvent());
    expect(message).toEqual({
      messageId: 'om_msg1',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderOpenId: 'ou_user',
      text: 'hello',
      mentions: [],
      attachments: [],
      createdAt: 1_700_000_000_000,
    });
  });

  it('classifies group chats', () => {
    const message = normalizeMessageEvent(rawEvent({ message: { chat_type: 'group' } }));
    expect(message?.chatType).toBe('group');
  });

  it('strips mention placeholders and trims', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: { content: JSON.stringify({ text: 'hi <at user_id="ou_x">@bot</at> there' }) },
      }),
    );
    expect(message?.text).toBe('hi there');
  });

  it('normalizes an image message into an image attachment', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_v2_abc' }),
        },
      }),
    );
    expect(message).toEqual({
      messageId: 'om_msg1',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderOpenId: 'ou_user',
      text: '',
      mentions: [],
      attachments: [{ kind: 'image', key: 'img_v2_abc' }],
      createdAt: 1_700_000_000_000,
    });
  });

  it('normalizes a file message into a file attachment with its name', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'file',
          content: JSON.stringify({ file_key: 'file_v2_xyz', file_name: 'notes.txt' }),
        },
      }),
    );
    expect(message?.attachments).toEqual([{ kind: 'file', key: 'file_v2_xyz', name: 'notes.txt' }]);
    expect(message?.text).toBe('');
  });

  it('ignores an image message without a key', () => {
    const message = normalizeMessageEvent(
      rawEvent({ message: { message_type: 'image', content: JSON.stringify({}) } }),
    );
    expect(message).toBeUndefined();
  });

  it('surfaces known-but-unhandled types (media, sticker) as unsupported; ignores unknown ones', () => {
    for (const type of ['media', 'sticker']) {
      const message = normalizeMessageEvent(
        rawEvent({ message: { message_type: type, content: '{}' } }),
      );
      expect(message?.unsupportedType).toBe(type);
    }
    expect(
      normalizeMessageEvent(rawEvent({ message: { message_type: 'nonsense' } })),
    ).toBeUndefined();
  });

  it('extracts mention open ids', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          mentions: [
            { key: '@_user_1', id: { open_id: 'ou_user' }, name: 'user' },
            { key: '@_user_2', id: { open_id: 'ou_other' }, name: 'other' },
            { key: 'all', id: {} },
          ],
        },
      }),
    );
    expect(message?.mentions).toEqual(['ou_user', 'ou_other']);
  });

  it('ignores unparseable content', () => {
    const message = normalizeMessageEvent(rawEvent({ message: { content: 'not json' } }));
    expect(message).toBeUndefined();
  });

  it('normalizes a rich-text post into serialized text + ordered attachments', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'post',
          content: JSON.stringify({
            title: '',
            content: [
              [{ tag: 'text', text: 'First:', style: ['bold'] }],
              [{ tag: 'img', image_key: 'img_1' }],
              [{ tag: 'media', file_key: 'file_v', image_key: 'img_c' }],
            ],
          }),
        },
      }),
    );
    expect(message?.text).toBe('**First:**\n<image 1>\n<video 2>');
    expect(message?.attachments).toEqual([
      { kind: 'image', key: 'img_1' },
      { kind: 'file', key: 'file_v' },
    ]);
  });

  it('normalizes a video message into a file attachment', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'video',
          content: JSON.stringify({ file_key: 'file_v1', image_key: 'img_c1' }),
        },
      }),
    );
    expect(message?.text).toBe('');
    expect(message?.attachments).toEqual([{ kind: 'file', key: 'file_v1' }]);
  });

  it('normalizes an audio (voice) message into a file attachment', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'audio',
          content: JSON.stringify({ file_key: 'file_a1', duration: '5000' }),
        },
      }),
    );
    expect(message?.text).toBe('');
    expect(message?.attachments).toEqual([{ kind: 'file', key: 'file_a1' }]);
  });

  it('surfaces a known-but-unhandled type (folder) as an unsupported-type message', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'folder',
          content: JSON.stringify({ file_key: 'f1', file_name: 'folder' }),
        },
      }),
    );
    expect(message?.unsupportedType).toBe('folder');
    expect(message?.text).toBe('');
    expect(message?.attachments).toEqual([]);
  });

  it('ignores an unknown message type entirely', () => {
    const message = normalizeMessageEvent(
      rawEvent({ message: { message_type: 'definitely-not-a-feishu-type' } }),
    );
    expect(message).toBeUndefined();
  });

  it('ignores a malformed post content', () => {
    const message = normalizeMessageEvent(
      rawEvent({ message: { message_type: 'post', content: 'not json' } }),
    );
    expect(message).toBeUndefined();
  });

  it('records a reply/quote parent id as quotedMessageId', () => {
    const message = normalizeMessageEvent(
      rawEvent({ message: { parent_id: 'om_parent' } as never }),
    );
    expect(message?.quotedMessageId).toBe('om_parent');
    // The body is NOT resolved here — the transport owns that API call.
    expect(message?.quoted).toBeUndefined();
  });

  it('omits quotedMessageId for a plain message', () => {
    expect(normalizeMessageEvent(rawEvent())).not.toHaveProperty('quotedMessageId');
  });

  it('keeps quotedMessageId on an unsupported-type message', () => {
    const message = normalizeMessageEvent(
      rawEvent({
        message: {
          message_type: 'sticker',
          content: '{}',
          parent_id: 'om_parent',
        } as never,
      }),
    );
    expect(message?.unsupportedType).toBe('sticker');
    expect(message?.quotedMessageId).toBe('om_parent');
  });
});

describe('parseMessageBody', () => {
  it('parses text (mentions stripped) and image bodies', () => {
    expect(
      parseMessageBody('text', JSON.stringify({ text: 'hi <at user_id="ou_x">@bot</at> there' })),
    ).toEqual({ text: 'hi there', attachments: [] });
    expect(parseMessageBody('image', JSON.stringify({ image_key: 'img_1' }))).toEqual({
      text: '',
      attachments: [{ kind: 'image', key: 'img_1' }],
    });
  });

  it('returns undefined for a malformed body', () => {
    expect(parseMessageBody('text', 'not json')).toBeUndefined();
    expect(parseMessageBody('image', JSON.stringify({}))).toBeUndefined();
  });
});

describe('normalizeQuotedMessage', () => {
  /** A `im.v1.message.get` response carrying one item. */
  function response(overrides: Record<string, unknown> = {}): unknown {
    return {
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_parent',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'the original question' }) },
            sender: { id: 'ou_author' },
            ...overrides,
          },
        ],
      },
    };
  }

  it('reads a quoted text message into text + sender', () => {
    expect(normalizeQuotedMessage(response(), 'om_parent')).toEqual({
      messageId: 'om_parent',
      senderOpenId: 'ou_author',
      text: 'the original question',
      attachments: [],
    });
  });

  it('keeps a quoted rich-text post ordered attachments and placeholders', () => {
    const quoted = normalizeQuotedMessage(
      response({
        msg_type: 'post',
        body: {
          content: JSON.stringify({
            content: [[{ tag: 'text', text: 'see:' }], [{ tag: 'img', image_key: 'img_1' }]],
          }),
        },
      }),
      'om_parent',
    );
    expect(quoted.text).toBe('see:\n<image 1>');
    expect(quoted.attachments).toEqual([{ kind: 'image', key: 'img_1' }]);
    expect(quoted.unavailable).toBeUndefined();
  });

  it('reads a quoted image message as an attachment, not as text', () => {
    const quoted = normalizeQuotedMessage(
      response({
        msg_type: 'image',
        body: { content: JSON.stringify({ image_key: 'img_9' }) },
      }),
      'om_parent',
    );
    expect(quoted.text).toBe('');
    expect(quoted.attachments).toEqual([{ kind: 'image', key: 'img_9' }]);
  });

  it('reports a quoted card (interactive) by type instead of forwarding its body', () => {
    const quoted = normalizeQuotedMessage(
      response({ msg_type: 'interactive', body: { content: '{"schema":"2.0"}' } }),
      'om_parent',
    );
    expect(quoted.unsupportedType).toBe('interactive');
    expect(quoted.text).toBe('');
    expect(quoted.attachments).toEqual([]);
  });

  it('surfaces an API error as unavailable instead of throwing', () => {
    const quoted = normalizeQuotedMessage({ code: 230098, msg: 'message not found' }, 'om_parent');
    expect(quoted.unavailable).toContain('message not found');
    expect(quoted.text).toBe('');
  });

  it('surfaces a missing or recalled quoted message as unavailable', () => {
    expect(
      normalizeQuotedMessage({ code: 0, data: { items: [] } }, 'om_parent').unavailable,
    ).toContain('not readable');
    expect(normalizeQuotedMessage(response({ deleted: true }), 'om_parent').unavailable).toContain(
      'recalled',
    );
  });

  it('surfaces an unparseable quoted body as unavailable', () => {
    const quoted = normalizeQuotedMessage(response({ body: { content: 'not json' } }), 'om_parent');
    expect(quoted.unavailable).toContain('could not be parsed');
  });
});

describe('LarkTransport quoted messages', () => {
  function quoteTransport(get: unknown): LarkTransport {
    const transport = new LarkTransport({
      credentials: { appId: 'cli_test', appSecret: 'secret' },
    });
    // Swap in a fake SDK client (never started here, so no network).
    (transport as unknown as { client: { im: { v1: { message: { get: unknown } } } } }).client = {
      im: { v1: { message: { get } } },
    } as never;
    return transport;
  }

  function inbound(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
    return {
      messageId: 'om_reply',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderOpenId: 'ou_user',
      text: 'what about this?',
      mentions: [],
      attachments: [],
      createdAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  async function deliver(
    transport: LarkTransport,
    message: FeishuMessage,
  ): Promise<FeishuMessage[]> {
    const delivered: FeishuMessage[] = [];
    transport.onMessage((m) => delivered.push(m));
    await (
      transport as unknown as { deliverInbound(m: FeishuMessage): Promise<void> }
    ).deliverInbound(message);
    return delivered;
  }

  it('resolves the quoted parent and attaches it to the delivered message', async () => {
    const get = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'the earlier message' }) },
            sender: { id: 'ou_other' },
          },
        ],
      },
    });
    const delivered = await deliver(quoteTransport(get), inbound({ quotedMessageId: 'om_parent' }));

    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_parent' },
      params: { user_id_type: 'open_id' },
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.quoted).toEqual({
      messageId: 'om_parent',
      senderOpenId: 'ou_other',
      text: 'the earlier message',
      attachments: [],
    });
    // The reply's own fields survive the hydration.
    expect(delivered[0]?.text).toBe('what about this?');
  });

  it('delivers an unreadable quote as unavailable instead of dropping it', async () => {
    const get = vi.fn().mockRejectedValue(new Error('boom'));
    const delivered = await deliver(quoteTransport(get), inbound({ quotedMessageId: 'om_parent' }));
    expect(delivered[0]?.quoted?.unavailable).toContain('boom');
  });

  it('reads no parent for a plain message (no extra API call)', async () => {
    const get = vi.fn();
    const delivered = await deliver(quoteTransport(get), inbound());
    expect(get).not.toHaveBeenCalled();
    expect(delivered[0]?.quoted).toBeUndefined();
  });
});

describe('normalizeCardAction', () => {
  it('normalizes the v2 context-nested shape', () => {
    const action = normalizeCardAction({
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_1' },
      action: { value: { kind: 'stop' } },
    } as never);
    expect(action).toEqual({
      messageId: 'om_1',
      chatId: 'oc_1',
      operatorOpenId: 'ou_1',
      value: { kind: 'stop' },
    });
  });

  it('falls back to top-level ids', () => {
    const action = normalizeCardAction({
      open_message_id: 'om_1',
      open_chat_id: 'oc_1',
      operator: { open_id: 'ou_1' },
      action: { value: { kind: 'copy' } },
    } as never);
    expect(action?.messageId).toBe('om_1');
    expect(action?.chatId).toBe('oc_1');
  });

  it('extracts form values from the action payload', () => {
    const action = normalizeCardAction({
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
      operator: { open_id: 'ou_1' },
      action: { value: { kind: 'repo-select' }, form_value: { repo: '/work/proj' } },
    } as never);
    expect(action?.formValue).toEqual({ repo: '/work/proj' });
    expect(action?.value).toEqual({ kind: 'repo-select' });
  });

  it('returns undefined without actionable ids or a value object', () => {
    expect(normalizeCardAction({} as never)).toBeUndefined();
    expect(
      normalizeCardAction({ open_message_id: 'om_1', open_chat_id: 'oc_1' } as never),
    ).toBeUndefined();
  });
});

describe('FeishuApiError', () => {
  it('carries the operation and code', () => {
    const error = new FeishuApiError('im.v1.message.create', 23, 'rate limited');
    expect(error.name).toBe('FeishuApiError');
    expect(error.code).toBe(23);
    expect(error.message).toContain('rate limited');
  });
});

describe('FEISHU_HTTP (SDK http instance)', () => {
  it('disables the proxy (regression: env proxies broke SDK calls)', () => {
    // The SDK's default axios instance honors http(s)_proxy env vars, which
    // crashes follow-redirects with "Protocol https: not supported" behind a
    // proxy (user report: WS endpoint discovery failed). The shared Feishu
    // instance must have the proxy disabled.
    expect(FEISHU_HTTP.defaults.proxy).toBe(false);
  });

  it('unwraps the response body like the SDK default (regression: code: undefined)', () => {
    // The SDK's callers destructure {code, data, msg} straight off
    // httpInstance.request(); a bare axios instance resolves to the
    // AxiosResponse wrapper and the WS endpoint discovery fails with
    // code=undefined. The response interceptor must return resp.data.
    const unwrap = FEISHU_HTTP.interceptors.response.handlers?.[0]?.fulfilled as (resp: {
      data: unknown;
      headers?: unknown;
      config: { $return_headers?: boolean };
    }) => unknown;
    expect(unwrap({ data: { code: 0, msg: 'ok' }, config: {} })).toEqual({ code: 0, msg: 'ok' });
    // The $return_headers passthrough the SDK relies on for downloads.
    expect(
      unwrap({ data: 'file', headers: { h: '1' }, config: { $return_headers: true } }),
    ).toEqual({ data: 'file', headers: { h: '1' } });
  });
});

describe('LarkTransport.createGroup', () => {
  it('sets the first member as the group owner at creation', async () => {
    const transport = new LarkTransport({
      credentials: { appId: 'cli_test', appSecret: 'secret' },
    });
    const create = vi.fn().mockResolvedValue({ code: 0, data: { chat_id: 'oc_new' } });
    // Swap in a fake SDK client (the real one is constructed internally and
    // never started in this test, so no network is involved).
    (transport as unknown as { client: { im: { v1: { chat: { create: unknown } } } } }).client = {
      im: { v1: { chat: { create } } },
    } as never;

    const result = await transport.createGroup('my team', ['ou_leader', 'ou_member']);

    expect(create).toHaveBeenCalledWith({
      data: {
        name: 'my team',
        user_id_list: ['ou_leader', 'ou_member'],
        owner_id: 'ou_leader',
      },
      params: { user_id_type: 'open_id' },
    });
    expect(result).toEqual({ chatId: 'oc_new' });
  });
});

describe('LarkTransport message-resource downloads', () => {
  /** A transport whose client's `request` is a fake returning `body`. */
  function transportWithRequest(body: unknown): {
    transport: LarkTransport;
    request: ReturnType<typeof vi.fn>;
  } {
    const transport = new LarkTransport({
      credentials: { appId: 'cli_test', appSecret: 'secret' },
    });
    const request = vi.fn().mockResolvedValue(body);
    (transport as unknown as { client: { request: unknown } }).client = {
      request,
    } as never;
    return { transport, request };
  }

  it('downloadFile streams the body and returns the head for sniffing', async () => {
    const body = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]);
    const { transport, request } = transportWithRequest({
      data: Readable.from([body]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    const { stream, head } = await transport.downloadFile('om_msg1', 'file_v3_key');

    expect(head).toEqual(body); // smaller than 16 bytes → whole body
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const collected = concat(chunks);
    expect(collected).toEqual(body);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/im/v1/messages/om_msg1/resources/file_v3_key',
        params: { type: 'file' },
        responseType: 'stream',
        $return_headers: true,
      }),
    );
  });

  it('downloadFile re-pushes the head so the stream still yields the full body', async () => {
    const body = new Uint8Array(Array.from({ length: 40 }, (_, i) => i));
    const { transport } = transportWithRequest({
      data: Readable.from([body]),
      headers: { 'content-type': 'application/octet-stream' },
    });

    const { stream, head } = await transport.downloadFile('om_msg1', 'file_v3_key');

    expect(head).toEqual(body.slice(0, 16));
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    expect(concat(chunks)).toEqual(body);
  });

  it('downloadImage returns bytes with the png default media type', async () => {
    const { transport, request } = transportWithRequest({
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      headers: { 'content-type': 'image/png' },
    });

    const image = await transport.downloadImage('om_msg1', 'img_v3_key');

    expect(image).toEqual({
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mediaType: 'image/png',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { type: 'image' },
        responseType: 'arraybuffer',
        $return_headers: true,
      }),
    );
  });

  it('downloadFile surfaces a JSON error envelope instead of persisting it', async () => {
    const envelope = JSON.stringify({ code: 99991661, msg: 'resource not found' });
    const { transport } = transportWithRequest({
      data: Readable.from([new TextEncoder().encode(envelope)]),
      headers: { 'content-type': 'application/json' },
    });

    await expect(transport.downloadFile('om_msg1', 'missing')).rejects.toMatchObject({
      name: 'FeishuApiError',
      operation: 'im.v1.messageResource.get (file)',
      code: 99991661,
    });
  });

  it('downloadFile throws when the response carries no bytes', async () => {
    const { transport } = transportWithRequest({ data: undefined, headers: {} });
    await expect(transport.downloadFile('om_msg1', 'empty')).rejects.toThrow(
      /response carried no resource bytes/,
    );
  });
});

describe('parseBotOpenId', () => {
  it('parses the current bot/v3/info shape (bot.open_id)', () => {
    expect(parseBotOpenId({ code: 0, bot: { open_id: 'ou_bot' }, msg: 'ok' })).toBe('ou_bot');
  });

  it('falls back to the legacy shape (data.open_id)', () => {
    expect(parseBotOpenId({ code: 0, data: { open_id: 'ou_bot' } })).toBe('ou_bot');
  });

  it('returns undefined when the body carries no open id', () => {
    expect(parseBotOpenId({ code: 0, bot: { activate_status: 2 } })).toBeUndefined();
    expect(parseBotOpenId({ code: 0 })).toBeUndefined();
    expect(parseBotOpenId({ code: 0, bot: { open_id: '' } })).toBeUndefined();
  });
});

describe('LarkTransport.resolveBotOpenId', () => {
  it('caches the bot open id from the current bot.open_id shape', async () => {
    const transport = new LarkTransport({
      credentials: { appId: 'cli_test', appSecret: 'secret' },
    });
    const request = vi.fn().mockResolvedValue({
      code: 0,
      msg: 'ok',
      bot: { activate_status: 2, open_id: 'ou_bot', app_name: 'dsh-feishu-test' },
    });
    (transport as unknown as { client: { request: unknown } }).client = { request } as never;

    await (transport as unknown as { resolveBotOpenId(): Promise<void> }).resolveBotOpenId();

    expect(request).toHaveBeenCalledWith({ method: 'GET', url: '/open-apis/bot/v3/info' });
    expect(transport.getBotOpenId()).toBe('ou_bot');
  });

  it('warns loudly and stays unresolved when the response carries no open id', async () => {
    const warns: string[] = [];
    const transport = new LarkTransport({
      credentials: { appId: 'cli_test', appSecret: 'secret' },
      logger: {
        info: () => {},
        warn: (message: string) => warns.push(message),
        error: () => {},
        debug: () => {},
      },
    });
    const request = vi.fn().mockResolvedValue({ code: 0, msg: 'ok' });
    (transport as unknown as { client: { request: unknown } }).client = { request } as never;

    await (transport as unknown as { resolveBotOpenId(): Promise<void> }).resolveBotOpenId();

    expect(transport.getBotOpenId()).toBeUndefined();
    expect(warns.join(' ')).toContain('group mention detection is disabled');
  });
});

/**
 * The bot open id arms the group mention gate, so a lookup that fails once
 * (an auto-start service races the network stack, and `open.feishu.cn` is
 * briefly unresolvable) must not leave the gate disabled forever.
 */
describe('LarkTransport bot open id retry', () => {
  /** The private surface these tests drive directly. */
  interface Internals {
    client: { request: unknown };
    ensureBotOpenId(): void;
  }

  function makeTransport(warns: string[]): LarkTransport {
    return new LarkTransport({
      credentials: { appId: 'cli_test', appSecret: 'secret' },
      logger: {
        info: () => {},
        warn: (message: string) => warns.push(message),
        error: () => {},
        debug: () => {},
      },
    });
  }

  it('retries a failed lookup and arms the gate once the network returns', async () => {
    vi.useFakeTimers();
    try {
      const warns: string[] = [];
      const transport = makeTransport(warns);
      const request = vi
        .fn()
        .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND open.feishu.cn'))
        .mockResolvedValue({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } });
      (transport as unknown as Internals).client = { request } as never;

      (transport as unknown as Internals).ensureBotOpenId();
      await vi.advanceTimersByTimeAsync(1);

      expect(transport.getBotOpenId()).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(1);
      expect(warns.join(' ')).toContain('bot open id resolution failed (attempt 1)');

      // The first backoff step (2s) runs the retry that succeeds.
      await vi.advanceTimersByTimeAsync(2_000);

      expect(request).toHaveBeenCalledTimes(2);
      expect(transport.getBotOpenId()).toBe('ou_bot');

      // A resolved id cancels the schedule: no further lookups are issued.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent calls into one in-flight lookup', async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport([]);
      const request = vi.fn().mockResolvedValue({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } });
      (transport as unknown as Internals).client = { request } as never;

      const internals = transport as unknown as Internals;
      internals.ensureBotOpenId();
      internals.ensureBotOpenId();
      internals.ensureBotOpenId();
      await vi.advanceTimersByTimeAsync(1);

      expect(request).toHaveBeenCalledTimes(1);
      expect(transport.getBotOpenId()).toBe('ou_bot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending retry when the transport stops', async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport([]);
      const request = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND open.feishu.cn'));
      (transport as unknown as Internals).client = { request } as never;

      (transport as unknown as Internals).ensureBotOpenId();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);

      await transport.stop();
      await vi.advanceTimersByTimeAsync(300_000);

      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Concatenate byte chunks into one Uint8Array (test helper). */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
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

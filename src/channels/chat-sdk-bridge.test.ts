import { describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

vi.mock('chat', () => {
  class MockChat {
    static lastInstance: MockChat | null = null;
    private handlers: Record<string, ((thread: { id: string }, message: any) => Promise<void>)[]> = {
      subscribed: [],
      mention: [],
      dm: [],
      plain: [],
    };

    constructor(_config: unknown) {
      MockChat.lastInstance = this;
    }

    onSubscribedMessage(handler: (thread: { id: string }, message: any) => Promise<void>) {
      this.handlers.subscribed.push(handler);
    }

    onNewMention(handler: (thread: { id: string }, message: any) => Promise<void>) {
      this.handlers.mention.push(handler);
    }

    onDirectMessage(handler: (thread: { id: string }, message: any) => Promise<void>) {
      this.handlers.dm.push(handler);
    }

    onNewMessage(_pattern: RegExp, handler: (thread: { id: string }, message: any) => Promise<void>) {
      this.handlers.plain.push(handler);
    }

    onAction() {}
    async initialize() {}
    async shutdown() {}

    async emitPlain(threadId: string, message: any) {
      for (const handler of this.handlers.plain) {
        await handler({ id: threadId }, message);
      }
    }
  }

  return {
    Chat: MockChat,
    Card: () => null,
    CardText: () => null,
    Actions: () => null,
    Button: () => null,
  };
});

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });

  it('drops inbound messages from ignored authors to prevent response loops', async () => {
    const adapter = stubAdapter({
      channelIdFromThreadId: (threadId: string) => `discord:${threadId}`,
      startTyping: async () => {},
    });
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      ignoredAuthorIds: ['bot-user-1'],
    });

    const onInbound = vi.fn();
    await bridge.setup({
      onInbound,
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const message = {
      id: 'msg-1',
      isMention: false,
      attachments: [],
      raw: null,
      metadata: { dateSent: new Date('2026-04-26T12:00:00.000Z') },
      author: { userId: 'bot-user-1', fullName: 'InfraClaw', bot: true },
      toJSON() {
        return {
          author: { userId: 'bot-user-1', fullName: 'InfraClaw', bot: true },
          text: 'loop candidate',
        };
      },
    };

    const { Chat } = await import('chat');
    const testChat = (
      Chat as unknown as { lastInstance: { emitPlain: (threadId: string, message: unknown) => Promise<void> } | null }
    ).lastInstance;
    expect(testChat).toBeTruthy();
    await testChat!.emitPlain('guild:chan', message);

    expect(onInbound).not.toHaveBeenCalled();
  });

  it('splits long text across multiple postMessage calls when maxTextLength is set', async () => {
    const postMessageCalls: Array<{ markdown: string }> = [];
    const adapter = stubAdapter({
      channelIdFromThreadId: (threadId: string) => `discord:${threadId}`,
      postMessage: async (_tid: string, payload: { markdown: string }) => {
        postMessageCalls.push(payload);
        return { id: `msg-${postMessageCalls.length}`, raw: null, threadId: _tid };
      },
    });

    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: false,
      maxTextLength: 50,
    });

    await bridge.setup({
      onInbound: vi.fn(),
      onInboundEvent: vi.fn(),
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const longText = 'a'.repeat(120);
    await bridge.deliver('discord:123', 'thread:1', {
      kind: 'chat',
      content: { markdown: longText, operation: 'send' },
    });

    expect(postMessageCalls.length).toBeGreaterThan(1);

    for (const call of postMessageCalls) {
      expect(call.markdown.length).toBeLessThanOrEqual(50);
    }

    const reconstructed = postMessageCalls.map((c) => c.markdown).join('');
    expect(reconstructed).toBe(longText);
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

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
});

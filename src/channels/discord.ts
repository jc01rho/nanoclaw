/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const botUserId = decodeDiscordBotUserId(env.DISCORD_BOT_TOKEN);
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    (discordAdapter as unknown as { botUserId?: string; applicationId?: string }).botUserId = botUserId;
    (discordAdapter as unknown as { botUserId?: string; applicationId?: string }).applicationId =
      env.DISCORD_APPLICATION_ID;
    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      ignoredAuthorIds: [env.DISCORD_APPLICATION_ID, botUserId].filter((v): v is string => Boolean(v)),
      extractReplyContext,
      supportsThreads: true,
    });
  },
});

function decodeDiscordBotUserId(token: string): string | undefined {
  const first = token.split('.')[0];
  if (!first) return undefined;
  try {
    return Buffer.from(first, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

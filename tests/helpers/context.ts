import { vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { AppConfig } from '../../src/config/env.js';
import type { CommandContext } from '../../src/discord/context.js';
import { GuildPlayer } from '../../src/player/guild-player.js';
import type { PlayerService } from '../../src/player/player-service.js';
import { FakeTransport, fakeLogger, fakeResolver } from './fake-transport.js';

export { fakeLogger };

export const fakeConfig: AppConfig = {
  discordToken: 'not-a-real-token',
  discordClientId: '111111111111111111',
  discordGuildId: '222222222222222222',
  logLevel: 'info',
  defaultVolume: 100,
  idleDisconnectSeconds: 300,
  ffmpegPath: 'ffmpeg',
};

export interface FakePlayers {
  get: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyAll: ReturnType<typeof vi.fn>;
  channelIdOf: ReturnType<typeof vi.fn>;
}

/** A command context wired to spies - no Discord, no voice, no FFmpeg. */
export function fakeContext(overrides: Partial<FakePlayers> = {}) {
  const logger = fakeLogger();
  const players: FakePlayers = {
    get: vi.fn().mockReturnValue(undefined),
    join: vi.fn(),
    destroy: vi.fn().mockReturnValue(false),
    destroyAll: vi.fn(),
    channelIdOf: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };

  const context: CommandContext = {
    config: fakeConfig,
    logger,
    players: players as unknown as PlayerService,
  };

  return { context, logger, players };
}

/**
 * A command context backed by a real `GuildPlayer` on a fake transport, so a
 * handler can be tested against genuine queue behaviour.
 */
export function contextWithPlayer(guildId = 'guild-1', channelId: string | null = 'vc-1') {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const player = new GuildPlayer({ guildId, transport, resolve: fakeResolver, logger });

  const { context, players } = fakeContext({
    get: vi.fn((id: string) => (id === guildId ? player : undefined)),
    channelIdOf: vi.fn((id: string) => (id === guildId ? channelId : undefined)),
    destroy: vi.fn((id: string) => {
      if (id !== guildId) {
        return false;
      }
      player.destroy();
      return true;
    }),
  });

  return { context, players, player, transport, logger };
}

export interface FakeInteractionOptions {
  guildId?: string | null;
  userId?: string;
  userChannelId?: string | null;
  stringOptions?: Record<string, string>;
}

/** Minimal chat input interaction: enough for the handlers, nothing more. */
export function fakeChatInput(options: FakeInteractionOptions = {}) {
  const guildId = options.guildId === undefined ? 'guild-1' : options.guildId;
  const userId = options.userId ?? 'user-1';
  const userChannelId = options.userChannelId === undefined ? 'vc-1' : options.userChannelId;

  const reply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const member = { voice: { channelId: userChannelId, channel: null } };

  const interaction = {
    user: { id: userId },
    deferred: false,
    replied: false,
    reply,
    editReply,
    deferReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getString: (name: string) => options.stringOptions?.[name] ?? null,
    },
    guild:
      guildId === null
        ? null
        : {
            id: guildId,
            members: { fetch: vi.fn().mockResolvedValue(member) },
          },
  };

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    reply,
    editReply,
  };
}

/** Content of the Nth reply, without leaking `any` into the assertions. */
export function replyContent(reply: ReturnType<typeof vi.fn>, index = 0): string {
  const payload = reply.mock.calls[index]?.[0] as { content?: string } | string | undefined;
  if (typeof payload === 'string') {
    return payload;
  }
  return payload?.content ?? '';
}

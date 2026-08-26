import { vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { AppConfig } from '../../src/config/env.js';
import type { CommandContext } from '../../src/discord/context.js';
import { GuildPlayer } from '../../src/player/guild-player.js';
import type { PlayerService } from '../../src/player/player-service.js';
import type { YouTubeMetadata, YouTubeMetadataProvider } from '../../src/youtube/metadata.js';
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
  ytdlpPath: 'yt-dlp',
};

/** Metadata a fake YouTube provider hands back by default. */
export const fakeMetadata: YouTubeMetadata = {
  videoId: 'dQw4w9WgXcQ',
  title: 'A YouTube Song',
  uploader: 'A Channel',
  durationMs: 213_000,
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg',
};

export interface FakePlayers {
  get: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyAll: ReturnType<typeof vi.fn>;
  channelIdOf: ReturnType<typeof vi.fn>;
}

export interface FakeContextOverrides extends Partial<FakePlayers> {
  /** Replaces the default metadata provider (which always succeeds). */
  fetchMetadata?: ReturnType<typeof vi.fn>;
}

/** A command context wired to spies - no Discord, no voice, no yt-dlp. */
export function fakeContext(overrides: FakeContextOverrides = {}) {
  const { fetchMetadata: fetchMetadataOverride, ...playerOverrides } = overrides;
  const logger = fakeLogger();
  const fetchMetadata = fetchMetadataOverride ?? vi.fn().mockResolvedValue(fakeMetadata);
  const youtube: YouTubeMetadataProvider = {
    fetchMetadata: fetchMetadata as unknown as YouTubeMetadataProvider['fetchMetadata'],
  };
  const players: FakePlayers = {
    get: vi.fn().mockReturnValue(undefined),
    join: vi.fn(),
    destroy: vi.fn().mockReturnValue(false),
    destroyAll: vi.fn(),
    channelIdOf: vi.fn().mockReturnValue(undefined),
    ...playerOverrides,
  };

  const context: CommandContext = {
    config: fakeConfig,
    logger,
    players: players as unknown as PlayerService,
    youtube,
  };

  return { context, logger, players, fetchMetadata };
}

/**
 * A command context backed by a real `GuildPlayer` on a fake transport, so a
 * handler can be tested against genuine queue behaviour.
 */
export function contextWithPlayer(guildId = 'guild-1', channelId: string | null = 'vc-1') {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const player = new GuildPlayer({ guildId, transport, resolve: fakeResolver, logger });

  const { context, players, fetchMetadata } = fakeContext({
    get: vi.fn((id: string) => (id === guildId ? player : undefined)),
    join: vi.fn(() => Promise.resolve(player)),
    channelIdOf: vi.fn((id: string) => (id === guildId ? channelId : undefined)),
    destroy: vi.fn((id: string) => {
      if (id !== guildId) {
        return false;
      }
      player.destroy();
      return true;
    }),
  });

  return { context, players, player, transport, logger, fetchMetadata };
}

export interface FakeInteractionOptions {
  guildId?: string | null;
  userId?: string;
  userChannelId?: string | null;
  stringOptions?: Record<string, string>;
  /** Permissions the bot is missing in the user's channel. */
  missingPermissions?: boolean;
}

/** Minimal chat input interaction: enough for the handlers, nothing more. */
export function fakeChatInput(options: FakeInteractionOptions = {}) {
  const guildId = options.guildId === undefined ? 'guild-1' : options.guildId;
  const userId = options.userId ?? 'user-1';
  const userChannelId = options.userChannelId === undefined ? 'vc-1' : options.userChannelId;
  const allowed = options.missingPermissions !== true;

  const reply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);

  const channel =
    userChannelId === null
      ? null
      : {
          id: userChannelId,
          toString: () => `<#${userChannelId}>`,
          permissionsFor: () => ({ has: () => allowed }),
        };
  const member = { voice: { channelId: userChannelId, channel } };
  const me = { id: 'bot-1' };

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
            voiceAdapterCreator: () => ({}),
            members: {
              me,
              fetch: vi.fn().mockResolvedValue(member),
              fetchMe: vi.fn().mockResolvedValue(me),
            },
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

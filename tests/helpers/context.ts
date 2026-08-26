import { vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';

import type { AppConfig } from '../../src/config/env.js';
import type { CommandContext } from '../../src/discord/context.js';
import { GuildPlayer } from '../../src/player/guild-player.js';
import type { PlayerService } from '../../src/player/player-service.js';
import type { YouTubeMetadata, YouTubeMetadataProvider } from '../../src/youtube/metadata.js';
import type { YouTubePlaylistImport, YouTubePlaylistProvider } from '../../src/youtube/playlist.js';
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
  maxPlaylistTracks: 100,
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

export const fakePlaylist: YouTubePlaylistImport = {
  playlist: {
    playlistId: 'PLabcdefghijklmnop',
    title: 'A YouTube Playlist',
    uploader: 'A Channel',
    canonicalUrl: 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
    itemCount: 3,
  },
  items: [
    fakeMetadata,
    {
      ...fakeMetadata,
      videoId: 'aaaaaaaaaaa',
      title: 'Playlist Track B',
      canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    },
    {
      ...fakeMetadata,
      videoId: 'bbbbbbbbbbb',
      title: 'Playlist Track C',
      canonicalUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
    },
  ],
  skippedCount: 0,
  limited: false,
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
  fetchPlaylist?: ReturnType<typeof vi.fn>;
}

/** A command context wired to spies - no Discord, no voice, no yt-dlp. */
export function fakeContext(overrides: FakeContextOverrides = {}) {
  const {
    fetchMetadata: fetchMetadataOverride,
    fetchPlaylist: fetchPlaylistOverride,
    ...playerOverrides
  } = overrides;
  const logger = fakeLogger();
  const fetchMetadata = fetchMetadataOverride ?? vi.fn().mockResolvedValue(fakeMetadata);
  const fetchPlaylist = fetchPlaylistOverride ?? vi.fn().mockResolvedValue(fakePlaylist);
  const youtube: YouTubeMetadataProvider & YouTubePlaylistProvider = {
    fetchMetadata: fetchMetadata as unknown as YouTubeMetadataProvider['fetchMetadata'],
    fetchPlaylist: fetchPlaylist as unknown as YouTubePlaylistProvider['fetchPlaylist'],
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

  return { context, logger, players, fetchMetadata, fetchPlaylist };
}

/**
 * A command context backed by a real `GuildPlayer` on a fake transport, so a
 * handler can be tested against genuine queue behaviour.
 */
export function contextWithPlayer(guildId = 'guild-1', channelId: string | null = 'vc-1') {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const player = new GuildPlayer({ guildId, transport, resolve: fakeResolver, logger });

  const { context, players, fetchMetadata, fetchPlaylist } = fakeContext({
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

  return { context, players, player, transport, logger, fetchMetadata, fetchPlaylist };
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

  // `reply` is the aggregate final-response spy retained for existing tests;
  // the method-specific spies prove deferred commands never double-ack.
  const reply = vi.fn<(payload: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const interactionReply = vi.fn<(payload: unknown) => Promise<void>>();
  const editReply = vi.fn(async (payload: unknown): Promise<void> => {
    await reply(payload);
  });
  const deferReply = vi.fn<() => Promise<void>>();

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
    commandName: 'skip',
    isChatInputCommand: () => true,
    user: { id: userId },
    deferred: false,
    replied: false,
    reply: interactionReply,
    editReply,
    deferReply,
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

  interactionReply.mockImplementation(async (payload: unknown): Promise<void> => {
    interaction.replied = true;
    await reply(payload);
  });
  deferReply.mockImplementation(() => {
    interaction.deferred = true;
    return Promise.resolve();
  });

  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    reply,
    editReply,
    deferReply,
    interactionReply,
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

import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { describe, expect, it, vi } from 'vitest';

import { PlayerService } from '../src/player/player-service.js';
import { VoiceSessionManager } from '../src/voice/session-manager.js';
import type { VoiceSessionHandle, VoiceSessionOptions } from '../src/voice/session.js';
import { FakeTransport, fakeLogger, fakeResolver, localTrack } from './helpers/fake-transport.js';

const adapterCreator = (() => ({})) as unknown as DiscordGatewayAdapterCreator;

/** A voice session that is really just the fake transport plus an identity. */
class FakeSession extends FakeTransport implements VoiceSessionHandle {
  readonly guildId: string;
  readonly channelId: string | null;
  destroyCount = 0;

  private readonly onDestroyed: ((guildId: string) => void) | undefined;

  constructor(options: VoiceSessionOptions) {
    super();
    this.guildId = options.guildId;
    this.channelId = options.channelId;
    this.onDestroyed = options.onDestroyed;
  }

  destroy(): void {
    this.destroyCount += 1;
    this.stopPlayback();
    this.onDestroyed?.(this.guildId);
  }
}

/** Like createService, but the voice handshake only finishes on demand. */
function createSlowService() {
  const sessions: FakeSession[] = [];
  const pending: (() => void)[] = [];
  const logger = fakeLogger();
  const voice = new VoiceSessionManager({
    ffmpegPath: 'ffmpeg',
    logger,
    createSession: (options) =>
      new Promise<FakeSession>((resolve) => {
        pending.push(() => {
          const session = new FakeSession(options);
          sessions.push(session);
          resolve(session);
        });
      }),
  });
  const players = new PlayerService({ voice, resolve: fakeResolver, logger });
  const settleJoins = (): void => {
    for (const finish of pending.splice(0)) {
      finish();
    }
  };
  return { players, voice, sessions, settleJoins, pendingCount: () => pending.length };
}

function createService() {
  const sessions: FakeSession[] = [];
  const logger = fakeLogger();
  const voice = new VoiceSessionManager({
    ffmpegPath: 'ffmpeg',
    logger,
    createSession: (options) => {
      const session = new FakeSession(options);
      sessions.push(session);
      return Promise.resolve(session);
    },
  });
  const players = new PlayerService({ voice, resolve: fakeResolver, logger });
  return { players, voice, sessions };
}

const request = { guildId: 'guild-1', channelId: 'vc-1', adapterCreator };

describe('PlayerService', () => {
  it('creates one player per guild, backed by the voice session', async () => {
    const { players, sessions } = createService();

    const player = await players.join(request);
    await player.enqueue(localTrack('a'));

    expect(players.get('guild-1')).toBe(player);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.lastPlayed).toEqual({ kind: 'file', input: 'a.opus' });
  });

  it('reuses the existing player instead of joining twice', async () => {
    const { players, sessions } = createService();

    const first = await players.join(request);
    const second = await players.join({ ...request, channelId: 'vc-2' });

    expect(second).toBe(first);
    expect(sessions).toHaveLength(1);
  });

  it('reports the channel the bot is connected to', async () => {
    const { players } = createService();

    expect(players.channelIdOf('guild-1')).toBeUndefined();
    await players.join(request);
    expect(players.channelIdOf('guild-1')).toBe('vc-1');
  });

  it('destroys the player and the session together', async () => {
    const { players, sessions, voice } = createService();
    const player = await players.join(request);
    await player.enqueue(localTrack('a'));

    expect(players.destroy('guild-1')).toBe(true);

    expect(players.get('guild-1')).toBeUndefined();
    expect(voice.get('guild-1')).toBeUndefined();
    expect(sessions[0]?.destroyCount).toBe(1);
    expect(player.current).toBeUndefined();
  });

  it('is idempotent and reports when there was nothing to destroy', async () => {
    const { players } = createService();
    await players.join(request);

    expect(players.destroy('guild-1')).toBe(true);
    expect(players.destroy('guild-1')).toBe(false);
    expect(players.destroy('guild-unknown')).toBe(false);
  });

  it('drops the player when the session dies on its own (kick, lost connection)', async () => {
    const { players, sessions } = createService();
    const player = await players.join(request);
    await player.enqueue(localTrack('a'));

    sessions[0]?.destroy();

    expect(players.get('guild-1')).toBeUndefined();
    expect(player.current).toBeUndefined();
  });

  it('keeps guilds isolated', async () => {
    const { players } = createService();

    const first = await players.join(request);
    const second = await players.join({ ...request, guildId: 'guild-2' });

    expect(second).not.toBe(first);
    players.destroy('guild-1');
    expect(players.get('guild-2')).toBe(second);
  });

  it('tears everything down on shutdown, twice if asked', async () => {
    const { players, sessions, voice } = createService();
    await players.join(request);
    await players.join({ ...request, guildId: 'guild-2' });

    players.destroyAll();
    players.destroyAll();

    expect(players.get('guild-1')).toBeUndefined();
    expect(voice.size).toBe(0);
    expect(sessions.map((session) => session.destroyCount)).toEqual([1, 1]);
  });

  it('does not let a destroyed player start anything else', async () => {
    const { players, sessions } = createService();
    const player = await players.join(request);

    players.destroy('guild-1');
    const result = await player.enqueue(localTrack('a'));

    expect(result.kind).toBe('failed');
    expect(sessions[0]?.played).toEqual([]);
  });
});

describe('PlayerService concurrent joins', () => {
  it('creates a single session and player for simultaneous /play commands', async () => {
    const { players, sessions, settleJoins, pendingCount } = createSlowService();

    const first = players.join(request);
    const second = players.join(request);
    // Both commands are already waiting on the same handshake.
    expect(pendingCount()).toBe(1);
    settleJoins();

    const [firstPlayer, secondPlayer] = await Promise.all([first, second]);

    expect(secondPlayer).toBe(firstPlayer);
    expect(sessions).toHaveLength(1);
    expect(players.get('guild-1')).toBe(firstPlayer);
  });

  it('does not leave a guild connected when a disconnect wins the join race', async () => {
    const { players, sessions, settleJoins } = createSlowService();

    const joining = players.join(request);
    players.destroy('guild-1');
    settleJoins();

    await expect(joining).rejects.toThrow(/disconnected|cancelled/i);
    expect(players.get('guild-1')).toBeUndefined();
    expect(sessions.every((session) => session.destroyCount > 0)).toBe(true);
  });
});

describe('PlayerService shutdown', () => {
  it('aborts an attempt that is still resolving', async () => {
    const started: AbortSignal[] = [];
    const logger = fakeLogger();
    const voice = new VoiceSessionManager({
      ffmpegPath: 'ffmpeg',
      logger,
      createSession: (options) => Promise.resolve(new FakeSession(options)),
    });
    const players = new PlayerService({
      voice,
      resolve: (_track, context) =>
        new Promise((_resolve, reject) => {
          started.push(context.signal);
          context.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      logger,
    });

    const player = await players.join(request);
    const starting = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    players.destroyAll();
    await starting;

    expect(started[0]?.aborted).toBe(true);
  });

  it('refuses to join a guild once shutdown started, and stays idempotent', async () => {
    const { players } = createService();
    await players.join(request);

    players.destroyAll();
    players.destroyAll();

    await expect(players.join({ ...request, guildId: 'guild-late' })).rejects.toThrow(
      /shutting down/i,
    );
  });
});

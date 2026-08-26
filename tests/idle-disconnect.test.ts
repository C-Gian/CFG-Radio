import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerService } from '../src/player/player-service.js';
import type { TrackResolver } from '../src/player/transport.js';
import { VoiceSessionManager } from '../src/voice/session-manager.js';
import type { VoiceSessionHandle, VoiceSessionOptions } from '../src/voice/session.js';
import { FakeTransport, fakeLogger, fakeResolver, localTrack } from './helpers/fake-transport.js';

const adapterCreator = (() => ({})) as unknown as DiscordGatewayAdapterCreator;
const request = { guildId: 'guild-1', channelId: 'vc-1', adapterCreator };

class FakeSession extends FakeTransport implements VoiceSessionHandle {
  readonly guildId: string;
  readonly channelId: string;
  destroyCount = 0;
  private destroyed = false;
  private readonly onDestroyed: ((guildId: string) => void) | undefined;

  constructor(options: VoiceSessionOptions) {
    super();
    this.guildId = options.guildId;
    this.channelId = options.channelId;
    this.onDestroyed = options.onDestroyed;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.destroyCount += 1;
    this.stopPlayback();
    this.onDestroyed?.(this.guildId);
  }
}

function createService(
  idleDisconnectSeconds = 1,
  defaultVolume = 100,
  resolve: TrackResolver = fakeResolver,
) {
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
  const players = new PlayerService({
    voice,
    resolve,
    logger,
    idleDisconnectSeconds,
    defaultVolume,
  });
  return { players, voice, sessions, logger };
}

describe('PlayerService idle disconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('disconnects after the last track ends naturally', async () => {
    const { players, sessions, voice } = createService();
    const player = await players.join(request);
    await player.enqueue(localTrack('a'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(players.get(request.guildId)).toBe(player);

    sessions[0]?.finishTrack();
    await player.whenSettled();
    await vi.advanceTimersByTimeAsync(999);
    expect(voice.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(players.get(request.guildId)).toBeUndefined();
    expect(voice.size).toBe(0);
    expect(sessions[0]?.destroyCount).toBe(1);
  });

  it.each(['skip', 'stop'] as const)(
    'starts a fresh timer after /%s empties playback',
    async (op) => {
      const { players, sessions } = createService();
      const player = await players.join(request);
      await player.enqueueMany([localTrack('a')]);

      await player[op]();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(players.get(request.guildId)).toBeUndefined();
      expect(sessions[0]?.destroyCount).toBe(1);
    },
  );

  it('does not schedule while paused or while tracks remain queued', async () => {
    const { players, sessions } = createService();
    const player = await players.join(request);
    await player.enqueueMany([localTrack('a'), localTrack('b')]);
    await player.pause();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(players.get(request.guildId)).toBe(player);
    expect(player.snapshot()).toMatchObject({ status: 'paused' });
    expect(player.snapshot().upcoming).toHaveLength(1);
    expect(sessions[0]?.destroyCount).toBe(0);
  });

  it('a new play cancels a nearly expired timer', async () => {
    const { players, sessions } = createService();
    const player = await players.join(request);
    await vi.advanceTimersByTimeAsync(999);

    await player.enqueue(localTrack('new'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(players.get(request.guildId)).toBe(player);
    expect(player.current?.sourceId).toBe('new');
    expect(sessions[0]?.destroyCount).toBe(0);
  });

  it('does not disconnect while a provider resolution is in progress', async () => {
    let release: (() => void) | undefined;
    const slowResolver = (track: ReturnType<typeof localTrack>) =>
      new Promise<ReturnType<typeof fakeResolver>>((resolve) => {
        release = () => {
          resolve(fakeResolver(track));
        };
      });
    const { players, sessions } = createService(1, 100, slowResolver);
    const player = await players.join(request);

    const enqueue = player.enqueue(localTrack('slow'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(players.get(request.guildId)).toBe(player);
    expect(sessions[0]?.destroyCount).toBe(0);

    release?.();
    await enqueue;
    expect(player.current?.sourceId).toBe('slow');
  });

  it('stop/new play cancels the old countdown and a later countdown is independent', async () => {
    const { players, sessions } = createService();
    const player = await players.join(request);
    await player.enqueue(localTrack('a'));
    await player.stop();
    await vi.advanceTimersByTimeAsync(900);
    await player.enqueue(localTrack('b'));
    await vi.advanceTimersByTimeAsync(200);
    expect(players.get(request.guildId)).toBe(player);

    await player.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(players.get(request.guildId)).toBeUndefined();
    expect(sessions[0]?.destroyCount).toBe(1);
  });

  it('manual disconnect cancels the timer and stale callbacks have no effect', async () => {
    const { players, sessions } = createService();
    await players.join(request);

    expect(players.destroy(request.guildId)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sessions[0]?.destroyCount).toBe(1);
    expect(players.destroy(request.guildId)).toBe(false);
  });

  it('an old session timer cannot disconnect replacement playback', async () => {
    const { players, sessions } = createService();
    await players.join(request);
    await vi.advanceTimersByTimeAsync(900);
    players.destroy(request.guildId);

    const replacement = await players.join(request);
    await replacement.enqueue(localTrack('replacement'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(players.get(request.guildId)).toBe(replacement);
    expect(replacement.current?.sourceId).toBe('replacement');
    expect(sessions.map((session) => session.destroyCount)).toEqual([1, 0]);
  });

  it('shutdown cancels every guild timer', async () => {
    const { players, sessions } = createService();
    await players.join(request);
    await players.join({ ...request, guildId: 'guild-2' });

    players.destroyAll();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sessions.map((session) => session.destroyCount)).toEqual([1, 1]);
  });

  it('resets volume to the configured default in a newly created session', async () => {
    const { players, sessions } = createService(1, 35);
    const first = await players.join(request);
    await first.setVolume(80);
    expect(sessions[0]?.volume).toBe(0.8);
    players.destroy(request.guildId);

    const second = await players.join(request);

    expect(second.snapshot().volume).toBe(35);
    expect(sessions[1]?.volume).toBe(0.35);
  });

  it('allows idle disconnect to be disabled with zero seconds', async () => {
    const { players } = createService(0);
    const player = await players.join(request);

    await vi.advanceTimersByTimeAsync(86_400_000);

    expect(players.get(request.guildId)).toBe(player);
  });
});

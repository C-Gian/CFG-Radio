import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { GuildPlayer } from '../src/player/guild-player.js';
import { ProviderError, type ProviderErrorCode } from '../src/player/provider-error.js';
import { createTrack, type Track } from '../src/player/track.js';
import type {
  PlaybackFallbackRequest,
  PlaybackFallbackResolver,
  PlayableSource,
  TrackResolver,
} from '../src/player/transport.js';
import {
  createSoundCloudFallbackResolver,
  isSoundCloudFallbackEligible,
} from '../src/soundcloud/fallback.js';
import { YtDlpRunner, type YtDlpChild } from '../src/youtube/ytdlp.js';
import { FakeTransport, fakeLogger, fakeResolver, localTrack } from './helpers/fake-transport.js';

/** A yt-dlp child that never answers, so a shutdown can interrupt it. */
class FakeYtDlpChild extends EventEmitter implements YtDlpChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  spawned = false;
}

const PRIMARY_SOURCE: PlayableSource = { kind: 'url', input: 'https://primary.invalid/audio' };
const FALLBACK_SOURCE: PlayableSource = { kind: 'url', input: 'https://fallback.invalid/audio' };

function youtubeTrack(id = 'youtube-a'): Track {
  return createTrack({
    title: 'Linkin Park - Numb',
    artist: 'Linkin Park',
    durationMs: 186_000,
    source: 'youtube',
    sourceId: id,
    originalInput: `https://www.youtube.com/watch?v=${id}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    requestedByUserId: 'user-1',
  });
}

function createPlayer(resolve: TrackResolver, resolveFallback?: PlaybackFallbackResolver) {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const player = new GuildPlayer({
    guildId: 'guild-1',
    transport,
    resolve,
    ...(resolveFallback === undefined ? {} : { resolveFallback }),
    logger,
  });
  return { player, transport, logger };
}

describe('SoundCloud fallback eligibility', () => {
  it.each(['unavailable', 'rate_limited', 'extractor_failed', 'timeout'] as const)(
    'allows YouTube resolution error %s',
    (code) => {
      expect(
        isSoundCloudFallbackEligible({
          track: youtubeTrack(),
          stage: 'resolution',
          signal: new AbortController().signal,
          error: new ProviderError(code, 'primary failed'),
        }),
      ).toBe(true);
    },
  );

  it.each(['geo_restricted', 'login_required', 'unsupported', 'not_found', 'unknown'] as const)(
    'refuses YouTube resolution error %s',
    (code) => {
      expect(
        isSoundCloudFallbackEligible({
          track: youtubeTrack(),
          stage: 'resolution',
          signal: new AbortController().signal,
          error: new ProviderError(code, 'primary failed'),
        }),
      ).toBe(false);
    },
  );

  it('allows a YouTube pre-start transport failure but never a local failure', () => {
    expect(
      isSoundCloudFallbackEligible({
        track: youtubeTrack(),
        stage: 'start',
        signal: new AbortController().signal,
        error: new Error('FFmpeg could not open primary source'),
      }),
    ).toBe(true);
    expect(
      isSoundCloudFallbackEligible({
        track: localTrack('arpeggio'),
        stage: 'start',
        signal: new AbortController().signal,
        error: new Error('local file failed'),
      }),
    ).toBe(false);
  });
});

describe('generic fallback playback orchestration', () => {
  it('never evaluates fallback when primary playback starts', async () => {
    const fallback = vi.fn<PlaybackFallbackResolver>();
    const { player } = createPlayer(() => PRIMARY_SOURCE, fallback);

    await player.enqueue(youtubeTrack());

    expect(fallback).not.toHaveBeenCalled();
  });

  it('calls fallback once for an eligible primary resolution failure', async () => {
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(FALLBACK_SOURCE);
    const { player, transport } = createPlayer(
      () => Promise.reject(new ProviderError('unavailable', 'gone')),
      fallback,
    );

    const result = await player.enqueue(youtubeTrack());

    expect(result.kind).toBe('started');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]?.[0]).toMatchObject({ stage: 'resolution' });
    expect(transport.played).toEqual([FALLBACK_SOURCE]);
    expect(player.current?.source).toBe('youtube');
  });

  it('allows fallback after primary resolves but transport fails before Playing', async () => {
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(FALLBACK_SOURCE);
    const { player, transport } = createPlayer(() => PRIMARY_SOURCE, fallback);
    transport.failFor(PRIMARY_SOURCE.input);

    const result = await player.enqueue(youtubeTrack());

    expect(result.kind).toBe('started');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]?.[0]).toMatchObject({ stage: 'start' });
    expect(transport.played).toEqual([FALLBACK_SOURCE]);
  });

  it('does not fallback after playback had reached Playing and later breaks', async () => {
    const fallback = vi.fn<PlaybackFallbackResolver>();
    const resolve = vi.fn((track: Track) =>
      track.source === 'local' ? fakeResolver(track) : PRIMARY_SOURCE,
    );
    const { player, transport } = createPlayer(resolve, fallback);
    await player.enqueueMany([youtubeTrack(), localTrack('next')]);

    transport.breakPlayback(new Error('stream died after Playing'));
    await player.whenSettled();

    expect(fallback).not.toHaveBeenCalled();
    expect(player.current?.sourceId).toBe('next');
  });

  it('fails normally when no fallback candidate is returned', async () => {
    const primary = new ProviderError('unavailable', 'gone');
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(undefined);
    const { player } = createPlayer(() => Promise.reject(primary), fallback);

    const result = await player.enqueue(youtubeTrack());

    expect(result).toMatchObject({ kind: 'failed', error: primary });
  });

  it('tries at most one fallback source and advances when it cannot start', async () => {
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(FALLBACK_SOURCE);
    const resolve = vi.fn((track: Track): PlayableSource | Promise<PlayableSource> =>
      track.source === 'youtube'
        ? Promise.reject(new ProviderError('timeout', 'primary timeout'))
        : fakeResolver(track),
    );
    const { player, transport } = createPlayer(resolve, fallback);
    transport.failFor(FALLBACK_SOURCE.input);

    await player.enqueueMany([youtubeTrack(), localTrack('next')]);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(player.current?.sourceId).toBe('next');
    expect(transport.played.map((source) => source.input)).toEqual(['next.opus']);
  });

  it('preserves FIFO and the original YouTube Track when fallback succeeds', async () => {
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(FALLBACK_SOURCE);
    const a = youtubeTrack();
    const b = localTrack('b');
    const resolve = (track: Track): PlayableSource | Promise<PlayableSource> =>
      track === a ? Promise.reject(new ProviderError('unavailable', 'gone')) : fakeResolver(track);
    const { player, transport } = createPlayer(resolve, fallback);

    await player.enqueueMany([a, b]);
    expect(player.current).toBe(a);
    expect(player.snapshot().upcoming).toEqual([b]);
    expect(a.canonicalUrl).toContain('youtube.com');

    transport.finishTrack();
    await player.whenSettled();
    expect(player.current).toBe(b);
  });

  it('stop during fallback resolution prevents every late start', async () => {
    let release: ((source: PlayableSource) => void) | undefined;
    const fallback = vi.fn<PlaybackFallbackResolver>(
      () =>
        new Promise<PlayableSource>((resolve) => {
          release = resolve;
        }),
    );
    const { player, transport } = createPlayer(
      () => Promise.reject(new ProviderError('timeout', 'primary timeout')),
      fallback,
    );

    const enqueue = player.enqueue(youtubeTrack());
    await vi.waitFor(() => {
      expect(fallback).toHaveBeenCalledTimes(1);
    });
    const stopping = player.stop();
    release?.(FALLBACK_SOURCE);
    await Promise.all([enqueue, stopping]);

    expect(transport.played).toEqual([]);
    expect(player.snapshot()).toMatchObject({ status: 'idle', upcoming: [] });
  });

  it('skip during fallback drops that track and starts the next FIFO item', async () => {
    let release: ((source: PlayableSource) => void) | undefined;
    const a = youtubeTrack();
    const fallback = vi.fn<PlaybackFallbackResolver>(
      () =>
        new Promise<PlayableSource>((resolve) => {
          release = resolve;
        }),
    );
    const resolve = (track: Track): PlayableSource | Promise<PlayableSource> =>
      track === a
        ? Promise.reject(new ProviderError('timeout', 'primary timeout'))
        : fakeResolver(track);
    const { player, transport } = createPlayer(resolve, fallback);

    const enqueue = player.enqueueMany([a, localTrack('next')]);
    await vi.waitFor(() => {
      expect(fallback).toHaveBeenCalledTimes(1);
    });
    const skipping = player.skip();
    release?.(FALLBACK_SOURCE);
    await Promise.all([enqueue, skipping]);

    expect(transport.played.map((source) => source.input)).toEqual(['next.opus']);
    expect(player.current?.sourceId).toBe('next');
  });

  it('destroy during fallback resolution prevents a late start', async () => {
    let release: ((source: PlayableSource) => void) | undefined;
    const fallback = vi.fn<PlaybackFallbackResolver>(
      () =>
        new Promise<PlayableSource>((resolve) => {
          release = resolve;
        }),
    );
    const { player, transport } = createPlayer(
      () => Promise.reject(new ProviderError('timeout', 'primary timeout')),
      fallback,
    );

    const enqueue = player.enqueue(youtubeTrack());
    await vi.waitFor(() => {
      expect(fallback).toHaveBeenCalledTimes(1);
    });
    player.destroy();
    release?.(FALLBACK_SOURCE);
    await enqueue;

    expect(transport.played).toEqual([]);
    expect(player.current).toBeUndefined();
  });

  it('each track-loop iteration retries YouTube primary before fallback', async () => {
    const primary = vi.fn(() => Promise.reject(new ProviderError('unavailable', 'gone')));
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(FALLBACK_SOURCE);
    const { player, transport } = createPlayer(primary, fallback);
    const track = youtubeTrack();
    await player.enqueue(track);
    await player.setLoopMode('track');

    transport.finishTrack();
    await player.whenSettled();

    expect(player.current).toBe(track);
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('queue-loop also starts each logical iteration from primary', async () => {
    const a = youtubeTrack();
    const primary = vi.fn((track: Track): PlayableSource | Promise<PlayableSource> =>
      track === a ? Promise.reject(new ProviderError('unavailable', 'gone')) : fakeResolver(track),
    );
    const fallback = vi.fn<PlaybackFallbackResolver>().mockResolvedValue(FALLBACK_SOURCE);
    const { player, transport } = createPlayer(primary, fallback);
    await player.enqueueMany([a, localTrack('b')]);
    await player.setLoopMode('queue');

    transport.finishTrack();
    await player.whenSettled();
    transport.finishTrack();
    await player.whenSettled();

    expect(player.current).toBe(a);
    expect(primary.mock.calls.filter(([track]) => track === a)).toHaveLength(2);
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});

describe('real SoundCloud fallback resolver with fake yt-dlp', () => {
  function searchPayload(second?: Record<string, unknown>) {
    return {
      entries: [
        {
          id: 'sc-good',
          title: 'Numb',
          track: 'Numb',
          uploader: 'Linkin Park',
          duration: 186,
          webpage_url: 'https://soundcloud.com/linkinpark/numb',
        },
        ...(second === undefined ? [] : [second]),
      ],
    };
  }

  function request(code: ProviderErrorCode = 'unavailable'): PlaybackFallbackRequest {
    return {
      track: youtubeTrack(),
      stage: 'resolution',
      signal: new AbortController().signal,
      error: new ProviderError(code, 'primary failed'),
    };
  }

  it('searches once and resolves only a confident winner', async () => {
    const json = vi
      .fn()
      .mockResolvedValueOnce(searchPayload())
      .mockResolvedValueOnce({ url: FALLBACK_SOURCE.input, duration: 186 });
    const fallback = createSoundCloudFallbackResolver({
      ytdlp: { json } as unknown as YtDlpRunner,
      logger: fakeLogger(),
    });

    await expect(fallback(request())).resolves.toEqual(FALLBACK_SOURCE);
    expect(json).toHaveBeenCalledTimes(2);
  });

  it('rejects ambiguous candidates without resolving either playable source', async () => {
    const json = vi.fn().mockResolvedValue(
      searchPayload({
        id: 'sc-tie',
        title: 'Numb',
        uploader: 'Linkin Park',
        duration: 187,
        webpage_url: 'https://soundcloud.com/linkinpark/numb-two',
      }),
    );
    const fallback = createSoundCloudFallbackResolver({
      ytdlp: { json } as unknown as YtDlpRunner,
      logger: fakeLogger(),
    });

    await expect(fallback(request())).resolves.toBeUndefined();
    expect(json).toHaveBeenCalledTimes(1);
  });

  it('does not try a second candidate after winner playable resolution fails', async () => {
    const json = vi
      .fn()
      .mockResolvedValueOnce(searchPayload())
      .mockRejectedValueOnce(new ProviderError('unavailable', 'DRM protected'));
    const fallback = createSoundCloudFallbackResolver({
      ytdlp: { json } as unknown as YtDlpRunner,
      logger: fakeLogger(),
    });

    await expect(fallback(request())).resolves.toBeUndefined();
    expect(json).toHaveBeenCalledTimes(2);
  });

  it.each(['login_required', 'geo_restricted', 'unsupported'] as const)(
    'does not search for non-fallback error %s',
    async (code) => {
      const json = vi.fn();
      const fallback = createSoundCloudFallbackResolver({
        ytdlp: { json } as unknown as YtDlpRunner,
        logger: fakeLogger(),
      });

      await expect(fallback(request(code))).resolves.toBeUndefined();
      expect(json).not.toHaveBeenCalled();
    },
  );
});

describe('fallback never fights the session lifecycle', () => {
  it('keeps the guild non-idle while a fallback attempt is in flight', async () => {
    let release: ((source: PlayableSource | undefined) => void) | undefined;
    const idleReports: boolean[] = [];
    const transport = new FakeTransport();
    const player = new GuildPlayer({
      guildId: 'guild-1',
      transport,
      resolve: () => Promise.reject(new ProviderError('unavailable', 'primary gone')),
      resolveFallback: () =>
        new Promise<PlayableSource | undefined>((resolve) => {
          release = resolve;
        }),
      logger: fakeLogger(),
      onIdleChange: (idle) => idleReports.push(idle),
    });

    const enqueue = player.enqueue(youtubeTrack());
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });

    // The idle disconnect timer keys off exactly this: a session that is still
    // trying to start playback must never look idle.
    expect(player.isIdle).toBe(false);
    expect(idleReports).not.toContain(true);

    release?.(FALLBACK_SOURCE);
    await enqueue;

    expect(player.isIdle).toBe(false);
    expect(transport.played).toEqual([FALLBACK_SOURCE]);
  });

  it('aborts an in-flight fallback search when the process shuts down', async () => {
    const child = new FakeYtDlpChild();
    const logger = fakeLogger();
    const runner = new YtDlpRunner({
      ytdlpPath: 'yt-dlp',
      logger,
      timeoutMs: 30_000,
      spawnFn: () => {
        child.spawned = true;
        return child;
      },
    });
    const { player, transport } = createPlayer(
      () => Promise.reject(new ProviderError('unavailable', 'primary gone')),
      createSoundCloudFallbackResolver({ ytdlp: runner, logger }),
    );

    const enqueue = player.enqueue(youtubeTrack());
    // The search really has to be running before the shutdown is triggered.
    await vi.waitFor(() => {
      expect(child.spawned).toBe(true);
    });

    // Shutdown order used by src/index.ts: players first, then yt-dlp.
    player.destroy();
    runner.destroy();

    await expect(enqueue).resolves.toMatchObject({ kind: 'failed' });
    expect(child.kill).toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(transport.played).toEqual([]);
  });
});

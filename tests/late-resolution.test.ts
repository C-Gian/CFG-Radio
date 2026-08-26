import { describe, expect, it, vi } from 'vitest';

import { createTrackResolver } from '../src/audio/track-resolver.js';
import { GuildPlayer, IMMEDIATE_SOURCE_MAX_AGE_MS } from '../src/player/guild-player.js';
import { ProviderError } from '../src/player/provider-error.js';
import { createTrack, type Track } from '../src/player/track.js';
import type { PlayableSource } from '../src/player/transport.js';
import type { YtDlpRunner } from '../src/youtube/ytdlp.js';
import { FakeTransport, fakeLogger, localTrack } from './helpers/fake-transport.js';

const MEDIA_URL = 'https://rr5---sn-abc.googlevideo.com/videoplayback?expire=1&sig=secret';

function youtubeTrack(videoId: string, title = `Video ${videoId}`): Track {
  return createTrack({
    title,
    source: 'youtube',
    sourceId: videoId,
    originalInput: `https://youtu.be/${videoId}`,
    requestedByUserId: 'user-1',
    durationMs: 210_000,
    artist: 'A Channel',
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  });
}

/** Resolver spy that behaves like the real one without any process. */
function trackingResolver(failing: ReadonlySet<string> = new Set()) {
  const calls: Track[] = [];
  const resolve = vi.fn((track: Track): Promise<PlayableSource> => {
    calls.push(track);
    if (failing.has(track.sourceId)) {
      return Promise.reject(new ProviderError('unavailable', 'gone'));
    }
    return Promise.resolve(
      track.source === 'youtube'
        ? { kind: 'url', input: `${MEDIA_URL}&id=${track.sourceId}` }
        : { kind: 'file', input: `${track.sourceId}.opus` },
    );
  });
  return { resolve, calls };
}

function createPlayer(failing?: ReadonlySet<string>) {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const { resolve, calls } = trackingResolver(failing);
  const player = new GuildPlayer({ guildId: 'guild-1', transport, resolve, logger });
  return { player, transport, logger, resolve, calls };
}

describe('late playback resolution', () => {
  it('resolves the first track only when it starts', async () => {
    const { player, resolve } = createPlayer();

    await player.enqueue(youtubeTrack('aaaaaaaaaaa'));

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('does NOT resolve a track that is only queued', async () => {
    const { player, resolve, calls } = createPlayer();
    const first = youtubeTrack('aaaaaaaaaaa');
    const queued = youtubeTrack('bbbbbbbbbbb');

    await player.enqueue(first);
    await player.enqueue(queued);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(calls.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa']);
  });

  it('resolves the queued track exactly when auto-next reaches it', async () => {
    const { player, transport, resolve, calls } = createPlayer();
    await player.enqueue(youtubeTrack('aaaaaaaaaaa'));
    await player.enqueue(youtubeTrack('bbbbbbbbbbb'));

    expect(resolve).toHaveBeenCalledTimes(1);

    transport.finishTrack();
    await player.whenSettled();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(calls.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  });

  it('never lets the signed media URL reach the track or the queue', async () => {
    const { player, transport } = createPlayer();
    const track = youtubeTrack('aaaaaaaaaaa');

    await player.enqueue(track);
    await player.enqueue(youtubeTrack('bbbbbbbbbbb'));

    expect(transport.lastPlayed?.input).toContain('googlevideo');
    expect(JSON.stringify(player.snapshot())).not.toContain('googlevideo');
    expect(JSON.stringify(track)).not.toContain('googlevideo');
  });

  it('re-resolves on every start, so an expired URL is never reused', async () => {
    const { player, transport, calls } = createPlayer();
    const track = youtubeTrack('aaaaaaaaaaa');

    await player.enqueue(track);
    await player.stop();
    await player.enqueue(track);

    expect(calls).toHaveLength(2);
    expect(transport.played).toHaveLength(2);
  });

  it('resolves playlist A now, B only after A, and C only after B', async () => {
    const { player, transport, calls } = createPlayer();
    const [a, b, c] = [
      youtubeTrack('aaaaaaaaaaa'),
      youtubeTrack('bbbbbbbbbbb'),
      youtubeTrack('ccccccccccc'),
    ];

    await player.enqueueMany([a, b, c]);
    expect(calls.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa']);

    transport.finishTrack();
    await player.whenSettled();
    expect(calls.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);

    transport.finishTrack();
    await player.whenSettled();
    expect(calls.map((track) => track.sourceId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ]);
    expect(JSON.stringify(player.snapshot())).not.toContain('googlevideo');
  });

  it('continues to C when playlist item B fails during late resolution', async () => {
    const { player, transport, calls } = createPlayer(new Set(['bbbbbbbbbbb']));
    await player.enqueueMany([
      youtubeTrack('aaaaaaaaaaa'),
      youtubeTrack('bbbbbbbbbbb'),
      youtubeTrack('ccccccccccc'),
    ]);

    transport.finishTrack();
    await player.whenSettled();

    expect(calls.map((track) => track.sourceId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ]);
    expect(player.current?.sourceId).toBe('ccccccccccc');
  });

  it('stop after B starts prevents any resolution of C', async () => {
    const { player, calls } = createPlayer();
    await player.enqueueMany([
      youtubeTrack('aaaaaaaaaaa'),
      youtubeTrack('bbbbbbbbbbb'),
      youtubeTrack('ccccccccccc'),
    ]);
    await player.skip();
    await player.stop();

    expect(calls.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(player.snapshot().upcoming).toEqual([]);
  });
});

describe('mixed local / YouTube queue', () => {
  it('keeps FIFO order across sources', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('arpeggio'));
    await player.enqueue(youtubeTrack('aaaaaaaaaaa'));
    await player.enqueue(localTrack('ascending'));

    transport.finishTrack();
    await player.whenSettled();
    transport.finishTrack();
    await player.whenSettled();

    expect(transport.played.map((source) => source.kind)).toEqual(['file', 'url', 'file']);
    expect(transport.played[0]?.input).toBe('arpeggio.opus');
    expect(transport.played[2]?.input).toBe('ascending.opus');
  });

  it('skips a YouTube track that fails at playback time and continues', async () => {
    const { player, transport, logger } = createPlayer(new Set(['bbbbbbbbbbb']));
    await player.enqueue(localTrack('arpeggio'));
    await player.enqueue(youtubeTrack('bbbbbbbbbbb'));
    await player.enqueue(localTrack('descending'));

    transport.finishTrack();
    await player.whenSettled();

    expect(player.current?.sourceId).toBe('descending');
    expect(transport.played.map((source) => source.input)).toEqual([
      'arpeggio.opus',
      'descending.opus',
    ]);
    expect(player.snapshot().upcoming).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports a failing YouTube track when it is the one being started', async () => {
    const { player } = createPlayer(new Set(['bbbbbbbbbbb']));

    const result = await player.enqueue(youtubeTrack('bbbbbbbbbbb'));

    expect(result.kind).toBe('failed');
    expect(result).toMatchObject({
      error: expect.objectContaining({ code: 'unavailable' }) as unknown,
    });
    expect(player.snapshot()).toMatchObject({ status: 'idle', upcoming: [] });
  });
});

describe('createTrackResolver', () => {
  it('sends local tracks to the catalog and YouTube tracks to yt-dlp', async () => {
    const json = vi.fn().mockResolvedValue({ url: 'https://media.test/a.webm' });
    const resolve = createTrackResolver({ ytdlp: { json } as unknown as YtDlpRunner });

    const youtube = await resolve(youtubeTrack('aaaaaaaaaaa'));
    expect(youtube).toMatchObject({ kind: 'url', input: 'https://media.test/a.webm' });

    const local = await resolve(localTrack('arpeggio'));
    expect(local).toMatchObject({ kind: 'file' });
    expect(local.input.replaceAll('\\', '/')).toMatch(/\/assets\/arpeggio\.opus$/);
    expect(json).toHaveBeenCalledTimes(1);
  });
});

describe('immediate source optimisation', () => {
  const IMMEDIATE: PlayableSource = { kind: 'url', input: 'https://immediate.invalid/audio' };

  it('starts an idle player from the offered source without resolving again', async () => {
    const { player, transport, resolve } = createPlayer();

    const result = await player.enqueue(youtubeTrack('aaaaaaaaaaa'), IMMEDIATE);

    expect(result.kind).toBe('started');
    expect(resolve).not.toHaveBeenCalled();
    expect(transport.played).toEqual([IMMEDIATE]);
  });

  it('discards the offered source when the track is queued instead', async () => {
    const { player, transport, resolve, calls } = createPlayer();
    await player.enqueue(youtubeTrack('aaaaaaaaaaa'));
    const queued = youtubeTrack('bbbbbbbbbbb');

    const result = await player.enqueue(queued, IMMEDIATE);
    expect(result.kind).toBe('queued');
    // Late resolution still governs everything that waits in the queue.
    expect(JSON.stringify(player.snapshot())).not.toContain('immediate.invalid');

    transport.finishTrack();
    await player.whenSettled();

    expect(calls.map((track) => track.sourceId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.played.map((source) => source.input)).not.toContain(IMMEDIATE.input);
  });

  it('never lets the offered source reach the Track', async () => {
    const { player } = createPlayer();
    const track = youtubeTrack('aaaaaaaaaaa');

    await player.enqueue(track, IMMEDIATE);

    expect(JSON.stringify(track)).not.toContain('immediate.invalid');
    expect(JSON.stringify(player.current)).not.toContain('immediate.invalid');
  });

  it('falls back to a fresh resolution when the offer went stale', async () => {
    const transport = new FakeTransport();
    let releaseFirst: ((error: Error) => void) | undefined;
    let first = true;
    const resolve = vi.fn((track: Track): Promise<PlayableSource> => {
      if (first) {
        first = false;
        return new Promise<PlayableSource>((_ignored, reject) => {
          releaseFirst = reject;
        });
      }
      return Promise.resolve({ kind: 'url', input: `${MEDIA_URL}&id=${track.sourceId}` });
    });
    const player = new GuildPlayer({
      guildId: 'guild-1',
      transport,
      resolve,
      logger: fakeLogger(),
    });

    // The offer is made while a previous attempt still owns the chain.
    const blocking = player.enqueue(youtubeTrack('blocking'));
    const offered = player.enqueue(youtubeTrack('aaaaaaaaaaa'), IMMEDIATE);

    // The blocking attempt has to own the chain before the clock is moved.
    await vi.waitFor(() => {
      expect(releaseFirst).toBeDefined();
    });

    const realNow = Date.now();
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + IMMEDIATE_SOURCE_MAX_AGE_MS + 1_000);
    try {
      releaseFirst?.(new Error('primary gone'));
      await blocking;
      await offered;
    } finally {
      clock.mockRestore();
    }

    // Two resolutions: the failed blocker, then a fresh one for the stale offer.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.played.map((source) => source.input)).toEqual([`${MEDIA_URL}&id=aaaaaaaaaaa`]);
  });
});

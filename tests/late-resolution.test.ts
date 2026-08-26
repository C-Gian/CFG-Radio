import { describe, expect, it, vi } from 'vitest';

import { createTrackResolver } from '../src/audio/track-resolver.js';
import { GuildPlayer } from '../src/player/guild-player.js';
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

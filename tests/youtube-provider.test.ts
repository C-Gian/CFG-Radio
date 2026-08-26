import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../src/player/provider-error.js';
import {
  metadataArgs,
  parseYouTubeMetadata,
  toYouTubeTrack,
  type YouTubeMetadata,
} from '../src/youtube/metadata.js';
import {
  AUDIO_FORMAT_SELECTOR,
  parsePlayableSource,
  playbackArgs,
  resolveYouTubePlayback,
} from '../src/youtube/playback.js';
import type { YtDlpRunner } from '../src/youtube/ytdlp.js';
import { createTrack, type Track } from '../src/player/track.js';

const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

const FULL_PAYLOAD = {
  id: VIDEO_ID,
  title: 'A Song',
  uploader: 'A Channel',
  channel: 'A Channel (other)',
  duration: 213.4,
  webpage_url: WATCH_URL,
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
};

function fakeRunner(json: unknown) {
  const runner = { json: vi.fn().mockResolvedValue(json) };
  return { runner: runner as unknown as YtDlpRunner, spy: runner.json };
}

describe('yt-dlp arguments', () => {
  it('asks for metadata only, one video, JSON, with the Node runtime', () => {
    const args = metadataArgs(WATCH_URL);

    expect(args).toEqual(
      expect.arrayContaining([
        '--no-js-runtimes',
        '--js-runtimes',
        'node',
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
        '--no-warnings',
      ]),
    );
    expect(args.at(-1)).toBe(WATCH_URL);
    expect(args).not.toContain('--format');
  });

  it('asks for an audio format when resolving playback', () => {
    const args = playbackArgs(WATCH_URL);

    expect(args).toContain('--format');
    expect(args).toContain(AUDIO_FORMAT_SELECTOR);
    expect(args).toContain('--no-playlist');
    expect(args).toContain('--skip-download');
    expect(args.at(-1)).toBe(WATCH_URL);
  });

  it('never passes cookies, a browser profile or a proxy', () => {
    const everything = [...metadataArgs(WATCH_URL), ...playbackArgs(WATCH_URL)].join(' ');

    expect(everything).not.toMatch(/--cookies|--proxy|--user-agent|--geo-bypass/);
  });
});

describe('parseYouTubeMetadata', () => {
  it('reads a complete payload', () => {
    const metadata = parseYouTubeMetadata(FULL_PAYLOAD, VIDEO_ID);

    expect(metadata).toEqual({
      videoId: VIDEO_ID,
      title: 'A Song',
      uploader: 'A Channel',
      durationMs: 213_400,
      canonicalUrl: WATCH_URL,
      thumbnailUrl: FULL_PAYLOAD.thumbnail,
    });
  });

  it('survives every optional field being missing', () => {
    const metadata = parseYouTubeMetadata({ id: VIDEO_ID, title: 'Bare' }, VIDEO_ID);

    expect(metadata).toEqual({
      videoId: VIDEO_ID,
      title: 'Bare',
      uploader: undefined,
      durationMs: undefined,
      canonicalUrl: WATCH_URL,
      thumbnailUrl: undefined,
    });
  });

  it('falls back to the channel when there is no uploader', () => {
    const metadata = parseYouTubeMetadata(
      { id: VIDEO_ID, title: 'X', channel: 'The Channel' },
      VIDEO_ID,
    );

    expect(metadata.uploader).toBe('The Channel');
  });

  it.each([
    ['a live stream with no duration', { id: VIDEO_ID, title: 'Live', duration: null }],
    ['a zero duration', { id: VIDEO_ID, title: 'Zero', duration: 0 }],
    ['a non-numeric duration', { id: VIDEO_ID, title: 'Weird', duration: 'PT3M' }],
  ])('reports no duration for %s', (_label, payload) => {
    expect(parseYouTubeMetadata(payload, VIDEO_ID).durationMs).toBeUndefined();
  });

  it('falls back to the requested id when the payload has none', () => {
    expect(parseYouTubeMetadata({ title: 'No id' }, VIDEO_ID).videoId).toBe(VIDEO_ID);
  });

  it.each([[null], [42], ['a string'], [{ id: VIDEO_ID }]])(
    'refuses the unusable payload %s',
    (payload) => {
      expect(() => parseYouTubeMetadata(payload, VIDEO_ID)).toThrow(ProviderError);
    },
  );
});

describe('toYouTubeTrack', () => {
  const metadata: YouTubeMetadata = {
    videoId: VIDEO_ID,
    title: 'A Song',
    uploader: 'A Channel',
    durationMs: 213_400,
    canonicalUrl: WATCH_URL,
    thumbnailUrl: 'https://i.ytimg.com/vi/x.jpg',
  };

  it('builds a queue-able track from the metadata', () => {
    const track = toYouTubeTrack({
      metadata,
      requestedByUserId: 'user-1',
      originalInput: `https://youtu.be/${VIDEO_ID}`,
    });

    expect(track).toMatchObject({
      title: 'A Song',
      source: 'youtube',
      sourceId: VIDEO_ID,
      durationMs: 213_400,
      artist: 'A Channel',
      canonicalUrl: WATCH_URL,
      requestedByUserId: 'user-1',
      originalInput: `https://youtu.be/${VIDEO_ID}`,
    });
  });

  it('never carries a direct media URL or any playback detail', () => {
    const track = toYouTubeTrack({
      metadata,
      requestedByUserId: 'user-1',
      originalInput: WATCH_URL,
    });

    const serialised = JSON.stringify(track);
    expect(serialised).not.toContain('googlevideo');
    expect(Object.keys(track).sort()).toEqual([
      'artist',
      'canonicalUrl',
      'durationMs',
      'id',
      'originalInput',
      'requestedAt',
      'requestedByUserId',
      'source',
      'sourceId',
      'thumbnailUrl',
      'title',
    ]);
  });
});

describe('parsePlayableSource', () => {
  it('extracts the direct URL and the headers FFmpeg needs', () => {
    const source = parsePlayableSource({
      url: 'https://rr5---sn-abc.googlevideo.com/videoplayback?expire=1',
      http_headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-us' },
    });

    expect(source).toEqual({
      kind: 'url',
      input: 'https://rr5---sn-abc.googlevideo.com/videoplayback?expire=1',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-us' },
    });
  });

  it('works without headers', () => {
    expect(parsePlayableSource({ url: 'https://media.test/audio.webm' })).toEqual({
      kind: 'url',
      input: 'https://media.test/audio.webm',
    });
  });

  it('never forwards cookies', () => {
    const source = parsePlayableSource({
      url: 'https://media.test/audio.webm',
      http_headers: { Cookie: 'SID=secret', 'User-Agent': 'Mozilla/5.0' },
    });

    expect(source.headers).toEqual({ 'User-Agent': 'Mozilla/5.0' });
  });

  it.each([[{}], [{ url: '' }], [{ url: 42 }], [{ url: 'file:///C:/etc/passwd' }], [null]])(
    'refuses the payload %s',
    (payload) => {
      expect(() => parsePlayableSource(payload)).toThrow(ProviderError);
    },
  );
});

describe('resolveYouTubePlayback', () => {
  function youtubeTrack(canonicalUrl?: string): Track {
    return createTrack({
      title: 'A Song',
      source: 'youtube',
      sourceId: VIDEO_ID,
      originalInput: WATCH_URL,
      requestedByUserId: 'user-1',
      canonicalUrl,
    });
  }

  it('resolves the media URL from the canonical page', async () => {
    const { runner, spy } = fakeRunner({ url: 'https://media.test/a.webm' });

    const source = await resolveYouTubePlayback(runner, youtubeTrack(WATCH_URL));

    expect(source).toMatchObject({ kind: 'url', input: 'https://media.test/a.webm' });
    expect(spy.mock.calls[0]?.[0]).toContain(WATCH_URL);
  });

  it('rebuilds the watch URL when the track has none', async () => {
    const { runner, spy } = fakeRunner({ url: 'https://media.test/a.webm' });

    await resolveYouTubePlayback(runner, youtubeTrack());

    expect(spy.mock.calls[0]?.[0]).toContain(WATCH_URL);
  });

  it('propagates a classified provider failure', async () => {
    const runner = {
      json: vi.fn().mockRejectedValue(new ProviderError('geo_restricted', 'nope')),
    } as unknown as YtDlpRunner;

    await expect(resolveYouTubePlayback(runner, youtubeTrack())).rejects.toMatchObject({
      code: 'geo_restricted',
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../src/player/provider-error.js';
import {
  parseSoundCloudCandidates,
  searchSoundCloudCandidates,
  soundCloudSearchArgs,
  type SoundCloudCandidate,
} from '../src/soundcloud/candidate.js';
import {
  parseSoundCloudPlayableSource,
  resolveSoundCloudPlayback,
  soundCloudPlaybackArgs,
} from '../src/soundcloud/playback.js';
import type { YtDlpRunner } from '../src/youtube/ytdlp.js';

const PAGE_URL = 'https://soundcloud.com/linkinpark/numb';
const DIRECT_URL = 'https://media.example/transient.m3u8?signature=ephemeral';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: '255824765',
    title: 'Numb',
    track: 'Numb',
    uploader: 'LINKIN PARK',
    duration: 187.566,
    webpage_url: PAGE_URL,
    ...overrides,
  };
}

function parsedCandidate(): SoundCloudCandidate {
  const result = parseSoundCloudCandidates({ entries: [entry()] });
  const item = result[0];
  if (item === undefined) throw new Error('candidate fixture failed to parse');
  return item;
}

describe('SoundCloud metadata search provider', () => {
  it('uses the verified scsearch syntax with a small flat metadata request', () => {
    expect(soundCloudSearchArgs('Linkin Park Numb', 5)).toEqual([
      '--flat-playlist',
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--ignore-config',
      'scsearch5:Linkin Park Numb',
    ]);
    expect(() => soundCloudSearchArgs('query', 11)).toThrow(/between 1 and 10/);
  });

  it.each([0, 1, 5])('parses a payload with %i result(s)', (count) => {
    const candidates = parseSoundCloudCandidates({
      entries: Array.from({ length: count }, (_value, index) =>
        entry({ id: String(index), webpage_url: `https://soundcloud.com/artist/song-${index}` }),
      ),
    });

    expect(candidates).toHaveLength(count);
  });

  it('keeps optional metadata optional and preserves the canonical page', () => {
    const [candidate] = parseSoundCloudCandidates({
      entries: [entry({ track: null, uploader: null, duration: null })],
    });

    expect(candidate).toMatchObject({
      id: '255824765',
      title: 'Numb',
      trackName: undefined,
      artist: undefined,
      durationMs: undefined,
      canonicalUrl: PAGE_URL,
      permalink: 'numb',
    });
  });

  it('skips entries missing identity, title or a SoundCloud canonical page', () => {
    const candidates = parseSoundCloudCandidates({
      entries: [
        entry({ id: null }),
        entry({ title: null }),
        entry({ webpage_url: DIRECT_URL }),
        entry({ webpage_url: 'https://soundcloud.example/artist/song' }),
        entry(),
      ],
    });

    expect(candidates).toHaveLength(1);
  });

  it.each([null, [], {}, { entries: null }])('rejects malformed payload %#', (payload) => {
    expect(() => parseSoundCloudCandidates(payload)).toThrow(ProviderError);
  });

  it('never carries a direct media URL out of metadata search', () => {
    const candidates = parseSoundCloudCandidates({
      entries: [entry({ url: DIRECT_URL, formats: [{ url: DIRECT_URL }] })],
    });

    expect(JSON.stringify(candidates)).not.toContain('media.example');
    expect(candidates[0]?.canonicalUrl).toBe(PAGE_URL);
  });

  it.each(['unavailable', 'timeout', 'rate_limited'] as const)(
    'propagates a classified %s search failure',
    async (code) => {
      const json = vi.fn().mockRejectedValue(new ProviderError(code, 'search failed'));
      const runner = { json } as unknown as YtDlpRunner;

      await expect(searchSoundCloudCandidates(runner, 'query')).rejects.toMatchObject({ code });
    },
  );
});

describe('SoundCloud playable resolution', () => {
  it('resolves only the selected candidate with the verified format selector', async () => {
    const candidate = parsedCandidate();
    const json = vi.fn().mockResolvedValue({
      url: DIRECT_URL,
      duration: 187.566,
      format_id: 'hls_aac_160k',
      http_headers: {
        'User-Agent': 'guest-agent',
        Cookie: 'must-not-leave-parser',
        Authorization: 'must-not-leave-parser',
      },
    });
    const source = await resolveSoundCloudPlayback({ json } as unknown as YtDlpRunner, candidate);

    expect(json.mock.calls[0]?.[0]).toEqual(soundCloudPlaybackArgs(PAGE_URL));
    expect(source).toEqual({
      kind: 'url',
      input: DIRECT_URL,
      headers: { 'User-Agent': 'guest-agent' },
    });
  });

  it.each([
    [{ url: DIRECT_URL, is_drm: true }, 'unsupported'],
    [{ url: DIRECT_URL, format_id: 'http_mp3_preview' }, 'unavailable'],
    [{ url: DIRECT_URL, duration: 30 }, 'unavailable'],
  ] as const)('rejects DRM, preview or truncated source %#', (payload, code) => {
    expect(() => parseSoundCloudPlayableSource(payload, parsedCandidate())).toThrow(
      expect.objectContaining({ code }) as unknown,
    );
  });
});

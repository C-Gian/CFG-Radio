import { describe, expect, it, vi } from 'vitest';

import { ProviderError } from '../src/player/provider-error.js';
import {
  fetchYouTubePlaylist,
  parseYouTubePlaylist,
  playlistItemsToTracks,
  playlistMetadataArgs,
} from '../src/youtube/playlist.js';
import type { YtDlpRunner } from '../src/youtube/ytdlp.js';

const PLAYLIST_ID = 'PLabcdefghijklmnop';
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;

const item = (id: string, title = `Track ${id}`) => ({
  id,
  title,
  duration: 61.25,
  uploader: 'Item Channel',
  webpage_url: `https://www.youtube.com/watch?v=${id}`,
});

const completePayload = {
  _type: 'playlist',
  id: PLAYLIST_ID,
  title: 'Small public playlist',
  uploader: 'Playlist Channel',
  webpage_url: PLAYLIST_URL,
  playlist_count: 3,
  entries: [item('aaaaaaaaaaa', 'A'), item('bbbbbbbbbbb', 'B'), item('ccccccccccc', 'C')],
};

describe('playlist yt-dlp arguments', () => {
  it('requests one flat metadata payload without selecting media', () => {
    const args = playlistMetadataArgs(PLAYLIST_URL);

    expect(args).toEqual(
      expect.arrayContaining([
        '--no-js-runtimes',
        '--js-runtimes',
        'node',
        '--compat-options',
        'no-youtube-unavailable-videos',
        '--flat-playlist',
        '--dump-single-json',
        '--skip-download',
        '--ignore-config',
        '--no-warnings',
      ]),
    );
    expect(args.at(-1)).toBe(PLAYLIST_URL);
    expect(args).not.toContain('--format');
    expect(args).not.toContain('--no-playlist');
  });

  it('never asks for cookies, accounts, proxies or downloads', () => {
    const args = playlistMetadataArgs(PLAYLIST_URL).join(' ');

    expect(args).not.toMatch(/--cookies|--proxy|--user-agent|--geo-bypass/);
    expect(args).not.toMatch(/--output|-o |--extract-audio/);
  });
});

describe('parseYouTubePlaylist', () => {
  it('reads complete playlist and item metadata in source order', () => {
    const parsed = parseYouTubePlaylist(completePayload, PLAYLIST_ID, 100);

    expect(parsed.playlist).toEqual({
      playlistId: PLAYLIST_ID,
      title: 'Small public playlist',
      uploader: 'Playlist Channel',
      canonicalUrl: PLAYLIST_URL,
      itemCount: 3,
    });
    expect(parsed.items.map((entry) => entry.videoId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ]);
    expect(parsed.items[0]).toMatchObject({
      title: 'A',
      uploader: 'Item Channel',
      durationMs: 61_250,
      canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    });
    expect(parsed).toMatchObject({ skippedCount: 0, limited: false });
  });

  it('keeps a title-less entry with other useful metadata and supplies a compact title', () => {
    const parsed = parseYouTubePlaylist(
      { entries: [{ id: 'aaaaaaaaaaa', duration: 12 }], id: PLAYLIST_ID },
      PLAYLIST_ID,
      100,
    );

    expect(parsed.items[0]).toEqual({
      videoId: 'aaaaaaaaaaa',
      title: 'YouTube video aaaaaaaaaaa',
      uploader: undefined,
      durationMs: 12_000,
      canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      thumbnailUrl: undefined,
    });
    expect(parsed.playlist.title).toContain(PLAYLIST_ID);
  });

  it('skips an id-only unavailable flat stub and preserves valid order', () => {
    const parsed = parseYouTubePlaylist(
      {
        id: PLAYLIST_ID,
        playlist_count: 4,
        entries: [
          item('aaaaaaaaaaa', 'A'),
          {
            id: 'gyy7__NKZYE',
            title: null,
            duration: null,
            availability: null,
            _type: 'url',
            url: 'https://www.youtube.com/watch?v=gyy7__NKZYE',
          },
          item('bbbbbbbbbbb', 'B'),
          item('ccccccccccc', 'C'),
        ],
      },
      PLAYLIST_ID,
      100,
    );

    expect(parsed.items.map((entry) => entry.videoId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ]);
    expect(parsed.skippedCount).toBe(1);
    expect(
      playlistItemsToTracks(parsed, 'user-1', PLAYLIST_URL).map((track) => track.sourceId),
    ).not.toContain('gyy7__NKZYE');
  });

  it('counts entries omitted by yt-dlp compatibility filtering as skipped', () => {
    const parsed = parseYouTubePlaylist(
      {
        id: PLAYLIST_ID,
        playlist_count: 4,
        entries: [item('aaaaaaaaaaa'), item('bbbbbbbbbbb'), item('ccccccccccc')],
      },
      PLAYLIST_ID,
      100,
    );

    expect(parsed.items).toHaveLength(3);
    expect(parsed.skippedCount).toBe(1);
  });

  it('skips missing identities and entries known to be private or deleted', () => {
    const parsed = parseYouTubePlaylist(
      {
        id: PLAYLIST_ID,
        entries: [
          item('aaaaaaaaaaa'),
          null,
          { title: 'No id' },
          { id: 'too-short', title: 'Bad id' },
          { id: 'bbbbbbbbbbb', title: '[Private video]' },
          { id: 'ccccccccccc', title: '[Deleted video]' },
          { id: 'ddddddddddd', title: 'Members', availability: 'subscriber_only' },
          { id: 'fffffffffff', title: '[Unavailable video]' },
          item('eeeeeeeeeee'),
        ],
      },
      PLAYLIST_ID,
      100,
    );

    expect(parsed.items.map((entry) => entry.videoId)).toEqual(['aaaaaaaaaaa', 'eeeeeeeeeee']);
    expect(parsed.skippedCount).toBe(7);
  });

  it('accepts a valid empty playlist', () => {
    const parsed = parseYouTubePlaylist({ id: PLAYLIST_ID, entries: [] }, PLAYLIST_ID, 100);

    expect(parsed.items).toEqual([]);
    expect(parsed.playlist.itemCount).toBe(0);
  });

  it.each([null, 'json', 42, {}, { entries: null }])(
    'rejects malformed payload %s with ProviderError',
    (payload) => {
      expect(() => parseYouTubePlaylist(payload, PLAYLIST_ID, 100)).toThrow(ProviderError);
    },
  );

  it('caps the first N valid entries without letting invalid entries consume slots', () => {
    const parsed = parseYouTubePlaylist(
      {
        id: PLAYLIST_ID,
        entries: [
          { title: 'missing id' },
          item('aaaaaaaaaaa'),
          { id: 'bbbbbbbbbbb', title: null, duration: null, availability: null },
          item('ccccccccccc'),
          item('ddddddddddd'),
        ],
      },
      PLAYLIST_ID,
      2,
    );

    expect(parsed.items.map((entry) => entry.videoId)).toEqual(['aaaaaaaaaaa', 'ccccccccccc']);
    expect(parsed.skippedCount).toBe(2);
    expect(parsed.limited).toBe(true);
  });
});

describe('playlist track creation', () => {
  it('creates ordinary provider-agnostic YouTube tracks in playlist order', () => {
    const playlist = parseYouTubePlaylist(completePayload, PLAYLIST_ID, 100);
    const tracks = playlistItemsToTracks(playlist, 'requester-42', PLAYLIST_URL);

    expect(tracks.map((track) => track.sourceId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
      'ccccccccccc',
    ]);
    expect(tracks.every((track) => track.source === 'youtube')).toBe(true);
    expect(tracks.every((track) => track.requestedByUserId === 'requester-42')).toBe(true);
    expect(tracks.every((track) => track.originalInput === PLAYLIST_URL)).toBe(true);
    expect(JSON.stringify(tracks)).not.toContain('googlevideo');
    expect(JSON.stringify(tracks)).not.toContain('media.test');
  });
});

describe('fetchYouTubePlaylist', () => {
  it('uses the central runner exactly once', async () => {
    const json = vi.fn().mockResolvedValue(completePayload);
    const runner = { json } as unknown as YtDlpRunner;

    const parsed = await fetchYouTubePlaylist(runner, PLAYLIST_URL, PLAYLIST_ID, 100);

    expect(parsed.items).toHaveLength(3);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0]?.[0]).toEqual(playlistMetadataArgs(PLAYLIST_URL));
  });
});

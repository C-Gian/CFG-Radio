import { ProviderError } from '../player/provider-error.js';
import type { Track } from '../player/track.js';
import { toYouTubeTrack, type YouTubeMetadata } from './metadata.js';
import { canonicalPlaylistUrl, canonicalWatchUrl, isYouTubeVideoId } from './url.js';
import { JS_RUNTIME_ARGS, type YtDlpRunner } from './ytdlp.js';

export interface YouTubePlaylistMetadata {
  readonly playlistId: string;
  readonly title: string;
  readonly uploader: string | undefined;
  readonly canonicalUrl: string;
  readonly itemCount: number | undefined;
}

export interface YouTubePlaylistImport {
  readonly playlist: YouTubePlaylistMetadata;
  readonly items: readonly YouTubeMetadata[];
  readonly skippedCount: number;
  readonly limited: boolean;
}

/** Flat metadata only: no item formats or direct media URLs are resolved. */
export function playlistMetadataArgs(playlistUrl: string): string[] {
  return [
    ...JS_RUNTIME_ARGS,
    '--compat-options',
    'no-youtube-unavailable-videos',
    '--flat-playlist',
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
    '--ignore-config',
    playlistUrl,
  ];
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readPositiveInteger(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readDurationMs(source: Record<string, unknown>): number | undefined {
  const value = source.duration;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : undefined;
}

const UNUSABLE_AVAILABILITY = new Set([
  'private',
  'premium_only',
  'subscriber_only',
  'needs_auth',
  'unavailable',
]);

function parseItem(payload: unknown): YouTubeMetadata | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }

  const source = payload as Record<string, unknown>;
  const videoId = readString(source, 'id');
  if (videoId === undefined || !isYouTubeVideoId(videoId)) {
    return undefined;
  }

  const availability = readString(source, 'availability');
  const rawTitle = readString(source, 'title');
  const uploader = readString(source, 'uploader') ?? readString(source, 'channel');
  const durationMs = readDurationMs(source);
  if (
    (availability !== undefined && UNUSABLE_AVAILABILITY.has(availability)) ||
    (rawTitle !== undefined && /^\[(?:private|deleted|unavailable) video\]$/i.test(rawTitle))
  ) {
    return undefined;
  }

  // Defensive fallback for extractors/configurations that still expose an
  // unavailable video as an id-only flat URL stub. Real YouTube entries have
  // at least one useful identity field; the observed unavailable stub has no
  // title, duration, uploader or channel despite carrying a valid video id.
  if (rawTitle === undefined && durationMs === undefined && uploader === undefined) {
    return undefined;
  }

  return {
    videoId,
    title: rawTitle ?? `YouTube video ${videoId}`,
    uploader,
    durationMs,
    canonicalUrl: canonicalWatchUrl(videoId),
    thumbnailUrl: readString(source, 'thumbnail'),
  };
}

/** Parses a flat playlist payload, skips unusable entries and caps valid items. */
export function parseYouTubePlaylist(
  payload: unknown,
  fallbackPlaylistId: string,
  maxTracks: number,
): YouTubePlaylistImport {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !Number.isInteger(maxTracks) ||
    maxTracks < 1
  ) {
    throw new ProviderError('extractor_failed', 'yt-dlp returned an unexpected playlist payload');
  }

  const source = payload as Record<string, unknown>;
  if (!Array.isArray(source.entries)) {
    throw new ProviderError('extractor_failed', 'yt-dlp returned no playlist entries');
  }

  const parsed = source.entries.map(parseItem);
  const validItems = parsed.filter((item): item is YouTubeMetadata => item !== undefined);
  const playlistId = readString(source, 'id') ?? fallbackPlaylistId;
  const explicitCount =
    readPositiveInteger(source, 'playlist_count') ?? readPositiveInteger(source, 'n_entries');
  const omittedByExtractor =
    explicitCount === undefined ? 0 : Math.max(0, explicitCount - source.entries.length);

  return {
    playlist: {
      playlistId,
      title: readString(source, 'title') ?? `YouTube playlist ${playlistId}`,
      uploader: readString(source, 'uploader') ?? readString(source, 'channel'),
      canonicalUrl: canonicalPlaylistUrl(playlistId),
      itemCount: explicitCount ?? source.entries.length,
    },
    items: validItems.slice(0, maxTracks),
    skippedCount: parsed.length - validItems.length + omittedByExtractor,
    limited: validItems.length > maxTracks,
  };
}

export async function fetchYouTubePlaylist(
  runner: YtDlpRunner,
  playlistUrl: string,
  playlistId: string,
  maxTracks: number,
): Promise<YouTubePlaylistImport> {
  const payload = await runner.json(playlistMetadataArgs(playlistUrl));
  return parseYouTubePlaylist(payload, playlistId, maxTracks);
}

export interface YouTubePlaylistProvider {
  fetchPlaylist(
    playlistUrl: string,
    playlistId: string,
    maxTracks: number,
  ): Promise<YouTubePlaylistImport>;
}

export function createYouTubePlaylistProvider(runner: YtDlpRunner): YouTubePlaylistProvider {
  return {
    fetchPlaylist: (playlistUrl, playlistId, maxTracks) =>
      fetchYouTubePlaylist(runner, playlistUrl, playlistId, maxTracks),
  };
}

export function playlistItemsToTracks(
  playlist: YouTubePlaylistImport,
  requestedByUserId: string,
  originalInput: string,
): Track[] {
  return playlist.items.map((metadata) =>
    toYouTubeTrack({ metadata, requestedByUserId, originalInput }),
  );
}

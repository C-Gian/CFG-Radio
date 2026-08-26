import { ProviderError } from '../player/provider-error.js';
import { createTrack, type Track } from '../player/track.js';
import { parsePlayableSource } from '../audio/playable-source.js';
import type { PlayableSource } from '../player/transport.js';
import { playbackArgs } from './playback.js';
import { canonicalWatchUrl } from './url.js';
import { JS_RUNTIME_ARGS, type YtDlpRunner } from './ytdlp.js';

/**
 * What CFG Radio keeps from a YouTube video.
 *
 * Everything except the id and the title is optional on purpose: a missing
 * uploader or thumbnail is never a reason to refuse playback.
 */
export interface YouTubeMetadata {
  readonly videoId: string;
  readonly title: string;
  readonly uploader: string | undefined;
  readonly durationMs: number | undefined;
  readonly canonicalUrl: string;
  readonly thumbnailUrl: string | undefined;
}

/** Metadata only: no format is selected, and nothing is downloaded. */
export function metadataArgs(videoUrl: string): string[] {
  return [
    ...JS_RUNTIME_ARGS,
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--ignore-config',
    videoUrl,
  ];
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readDurationMs(source: Record<string, unknown>): number | undefined {
  const value = source.duration;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value * 1000);
}

/** Parses a yt-dlp `--dump-single-json` payload defensively. */
export function parseYouTubeMetadata(payload: unknown, fallbackVideoId: string): YouTubeMetadata {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('extractor_failed', 'yt-dlp returned an unexpected payload');
  }

  const source = payload as Record<string, unknown>;
  const videoId = readString(source, 'id') ?? fallbackVideoId;
  const title = readString(source, 'title');

  if (title === undefined) {
    throw new ProviderError('extractor_failed', 'yt-dlp returned no title for this video');
  }

  return {
    videoId,
    title,
    uploader: readString(source, 'uploader') ?? readString(source, 'channel'),
    durationMs: readDurationMs(source),
    canonicalUrl: readString(source, 'webpage_url') ?? canonicalWatchUrl(videoId),
    thumbnailUrl: readString(source, 'thumbnail'),
  };
}

/** Resolves the metadata of a single YouTube video. */
export async function fetchYouTubeMetadata(
  runner: YtDlpRunner,
  videoUrl: string,
  videoId: string,
): Promise<YouTubeMetadata> {
  const payload = await runner.json(metadataArgs(videoUrl));
  return parseYouTubeMetadata(payload, videoId);
}

/**
 * Resolves metadata and a playable source with one yt-dlp extraction.
 *
 * Used only when a track is about to start right away; the source never
 * reaches the `Track` and is never queued or persisted.
 */
export async function fetchYouTubeVideo(
  runner: YtDlpRunner,
  videoUrl: string,
  videoId: string,
): Promise<YouTubeVideoResolution> {
  const payload = await runner.json(playbackArgs(videoUrl));
  return {
    metadata: parseYouTubeMetadata(payload, videoId),
    source: parsePlayableSource(payload),
  };
}

/**
 * The narrow view `/play` depends on.
 *
 * Declaring it keeps the command handler testable without a yt-dlp process.
 */
export interface YouTubeVideoResolution {
  readonly metadata: YouTubeMetadata;
  /**
   * Runtime-only source for an immediate start. It is discarded when the
   * track is queued instead: queued tracks are always resolved late.
   */
  readonly source: PlayableSource;
}

export interface YouTubeMetadataProvider {
  fetchMetadata(videoUrl: string, videoId: string): Promise<YouTubeMetadata>;
  /**
   * Metadata plus a playable source from a single extraction.
   *
   * A YouTube extraction costs about three seconds, and asking for metadata
   * and formats separately paid that twice for one `/play`.
   */
  fetchMetadataWithSource(videoUrl: string, videoId: string): Promise<YouTubeVideoResolution>;
}

export function createYouTubeMetadataProvider(runner: YtDlpRunner): YouTubeMetadataProvider {
  return {
    fetchMetadata: (videoUrl, videoId) => fetchYouTubeMetadata(runner, videoUrl, videoId),
    fetchMetadataWithSource: (videoUrl, videoId) => fetchYouTubeVideo(runner, videoUrl, videoId),
  };
}

export interface YouTubeTrackInput {
  readonly metadata: YouTubeMetadata;
  readonly requestedByUserId: string;
  /** Exactly what the user typed. */
  readonly originalInput: string;
}

/**
 * Turns metadata into a queue-able track.
 *
 * The track holds the *identity* of the video only - the playable media URL is
 * resolved later, when the track is about to be played.
 */
export function toYouTubeTrack(input: YouTubeTrackInput): Track {
  const { metadata } = input;
  return createTrack({
    title: metadata.title,
    source: 'youtube',
    sourceId: metadata.videoId,
    originalInput: input.originalInput,
    requestedByUserId: input.requestedByUserId,
    durationMs: metadata.durationMs,
    artist: metadata.uploader,
    canonicalUrl: metadata.canonicalUrl,
    thumbnailUrl: metadata.thumbnailUrl,
  });
}

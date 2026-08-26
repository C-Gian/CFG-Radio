import { ProviderError } from '../player/provider-error.js';
import type { Track } from '../player/track.js';
import type { PlayableSource } from '../player/transport.js';
import { canonicalWatchUrl } from './url.js';
import { JS_RUNTIME_ARGS, type YtDlpRunner } from './ytdlp.js';

/**
 * Audio-only first, anything else as a last resort. FFmpeg re-encodes to
 * Ogg/Opus anyway, so the container does not matter.
 */
export const AUDIO_FORMAT_SELECTOR = 'bestaudio[acodec=opus]/bestaudio/best';

/** Headers yt-dlp does not need to hand over to FFmpeg. */
const SKIPPED_HEADERS = new Set(['accept-encoding', 'cookie', 'host', 'connection']);

export function playbackArgs(videoUrl: string): string[] {
  return [
    ...JS_RUNTIME_ARGS,
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--ignore-config',
    '--format',
    AUDIO_FORMAT_SELECTOR,
    videoUrl,
  ];
}

function readHeaders(source: Record<string, unknown>): Record<string, string> | undefined {
  const raw = source.http_headers;
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // Cookies are never forwarded: CFG Radio does not use an account.
    if (typeof value === 'string' && !SKIPPED_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Extracts the direct media URL from a yt-dlp payload.
 *
 * The URL is short lived and signed: it belongs to the `PlayableSource` handed
 * to FFmpeg and must never be stored on a `Track` or in the queue.
 */
export function parsePlayableSource(payload: unknown): PlayableSource {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('extractor_failed', 'yt-dlp returned an unexpected payload');
  }

  const source = payload as Record<string, unknown>;
  const url = source.url;

  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new ProviderError('extractor_failed', 'yt-dlp returned no playable media URL');
  }

  const headers = readHeaders(source);
  return headers === undefined ? { kind: 'url', input: url } : { kind: 'url', input: url, headers };
}

/**
 * Late resolution: called by the player when the track is about to start, not
 * when it is queued.
 */
export async function resolveYouTubePlayback(
  runner: YtDlpRunner,
  track: Track,
): Promise<PlayableSource> {
  const videoUrl = track.canonicalUrl ?? canonicalWatchUrl(track.sourceId);
  const payload = await runner.json(playbackArgs(videoUrl));
  return parsePlayableSource(payload);
}

import { ProviderError } from '../player/provider-error.js';
import type { PlayableSource } from '../player/transport.js';

/** Headers that must never be handed to logs or an FFmpeg child. */
const SKIPPED_HEADERS = new Set([
  'accept-encoding',
  'authorization',
  'connection',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
]);

function readHeaders(source: Record<string, unknown>): Record<string, string> | undefined {
  const raw = source.http_headers;
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && !SKIPPED_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Extracts one ephemeral media URL from a structured yt-dlp payload.
 * The returned object is runtime-only and must never be queued or persisted.
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

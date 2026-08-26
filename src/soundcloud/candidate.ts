import { ProviderError } from '../player/provider-error.js';
import type { YtDlpRunOptions, YtDlpRunner } from '../youtube/ytdlp.js';

export const DEFAULT_SOUNDCLOUD_SEARCH_LIMIT = 5;
export const MAX_SOUNDCLOUD_SEARCH_LIMIT = 10;

/** Metadata-only search result. It deliberately contains no playable URL. */
export interface SoundCloudCandidate {
  readonly id: string;
  readonly title: string;
  readonly trackName: string | undefined;
  readonly artist: string | undefined;
  readonly durationMs: number | undefined;
  readonly canonicalUrl: string;
  readonly permalink: string;
}

export function soundCloudSearchArgs(
  query: string,
  limit = DEFAULT_SOUNDCLOUD_SEARCH_LIMIT,
): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SOUNDCLOUD_SEARCH_LIMIT) {
    throw new RangeError(
      `SoundCloud search limit must be between 1 and ${MAX_SOUNDCLOUD_SEARCH_LIMIT}`,
    );
  }
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new ProviderError('unsupported', 'SoundCloud fallback search query is empty');
  }
  return [
    '--flat-playlist',
    '--dump-single-json',
    '--skip-download',
    '--no-warnings',
    '--ignore-config',
    `scsearch${limit}:${trimmed}`,
  ];
}

export function parseSoundCloudCandidates(payload: unknown): SoundCloudCandidate[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('extractor_failed', 'SoundCloud search returned an unexpected payload');
  }
  const entries = (payload as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) {
    throw new ProviderError('extractor_failed', 'SoundCloud search returned no entries array');
  }

  const candidates: SoundCloudCandidate[] = [];
  for (const entry of entries) {
    const parsed = parseCandidate(entry);
    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }
  return candidates;
}

export async function searchSoundCloudCandidates(
  runner: YtDlpRunner,
  query: string,
  limit = DEFAULT_SOUNDCLOUD_SEARCH_LIMIT,
  options: YtDlpRunOptions = {},
): Promise<SoundCloudCandidate[]> {
  const payload = await runner.json(soundCloudSearchArgs(query, limit), options);
  return parseSoundCloudCandidates(payload);
}

function parseCandidate(value: unknown): SoundCloudCandidate | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const id = readString(source, 'id');
  const title = readString(source, 'title');
  const canonicalUrl = readString(source, 'webpage_url');
  if (id === undefined || title === undefined || canonicalUrl === undefined) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(canonicalUrl);
  } catch {
    return undefined;
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    !['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(parsedUrl.hostname)
  ) {
    return undefined;
  }

  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    return undefined;
  }

  return {
    id,
    title,
    trackName: readString(source, 'track'),
    artist:
      readString(source, 'artist') ??
      readString(source, 'uploader') ??
      readString(source, 'creator'),
    durationMs: readDurationMs(source.duration),
    canonicalUrl: parsedUrl.toString(),
    permalink: pathParts.at(-1) ?? '',
  };
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function readDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : undefined;
}

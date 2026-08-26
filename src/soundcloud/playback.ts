import { parsePlayableSource } from '../audio/playable-source.js';
import { ProviderError } from '../player/provider-error.js';
import type { PlayableSource } from '../player/transport.js';
import type { YtDlpRunner } from '../youtube/ytdlp.js';
import type { SoundCloudCandidate } from './candidate.js';

/** FFmpeg accepts both the HTTP and HLS audio variants exposed by SoundCloud. */
export const SOUNDCLOUD_AUDIO_FORMAT_SELECTOR = 'bestaudio/best';

export function soundCloudPlaybackArgs(candidateUrl: string): string[] {
  return [
    '--dump-single-json',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    '--ignore-config',
    '--format',
    SOUNDCLOUD_AUDIO_FORMAT_SELECTOR,
    candidateUrl,
  ];
}

export function parseSoundCloudPlayableSource(
  payload: unknown,
  candidate: SoundCloudCandidate,
): PlayableSource {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('extractor_failed', 'SoundCloud returned an unexpected payload');
  }
  const source = payload as Record<string, unknown>;
  if (source.is_drm === true) {
    throw new ProviderError('unsupported', 'SoundCloud candidate is DRM protected');
  }

  const formatDescription = [source.format_id, source.format_note]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  if (/(?:preview|snippet|sample)/i.test(formatDescription)) {
    throw new ProviderError('unavailable', 'SoundCloud candidate exposes only a preview');
  }

  const resolvedDurationMs = readDurationMs(source.duration);
  if (
    candidate.durationMs !== undefined &&
    resolvedDurationMs !== undefined &&
    resolvedDurationMs < candidate.durationMs * 0.9
  ) {
    throw new ProviderError('unavailable', 'SoundCloud playable source is shorter than its track');
  }
  return parsePlayableSource(payload);
}

export async function resolveSoundCloudPlayback(
  runner: YtDlpRunner,
  candidate: SoundCloudCandidate,
): Promise<PlayableSource> {
  const payload = await runner.json(soundCloudPlaybackArgs(candidate.canonicalUrl));
  return parseSoundCloudPlayableSource(payload, candidate);
}

function readDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : undefined;
}

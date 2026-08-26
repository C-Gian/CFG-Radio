import { providerErrorCode, type ProviderErrorCode } from '../player/provider-error.js';
import type { UnsupportedReason } from '../youtube/url.js';

/**
 * Short, human answers for provider failures.
 *
 * yt-dlp stderr never reaches a user: it stays in the logs, and only the
 * classified code decides what is said.
 */
const PROVIDER_MESSAGES: Record<ProviderErrorCode, string> = {
  not_found: 'I could not find that video.',
  unavailable: 'This YouTube video is unavailable.',
  geo_restricted: 'This video is not available in this region.',
  login_required: 'This video requires login and cannot be played.',
  rate_limited: 'YouTube is rate limiting me right now. Try again in a few minutes.',
  extractor_failed: 'I could not read that video. It may be restricted or unsupported.',
  timeout: 'YouTube took too long to respond.',
  unsupported: 'That URL is not a supported YouTube video.',
  unknown: 'Something went wrong while loading that video.',
};

const UNSUPPORTED_MESSAGES: Record<UnsupportedReason, string> = {
  playlist: 'Playlist support is not available yet. Give me a single video URL.',
  search: 'Search is not available yet. Give me a YouTube video URL.',
  'not-youtube': 'Only YouTube video URLs are supported for now.',
  malformed: 'That URL is not a supported YouTube video.',
};

export function providerErrorMessage(error: unknown): string {
  return PROVIDER_MESSAGES[providerErrorCode(error)];
}

export function unsupportedInputMessage(reason: UnsupportedReason): string {
  return UNSUPPORTED_MESSAGES[reason];
}

/**
 * Input classification for `/play`.
 *
 * Pure and strict: the hostname is matched against an allowlist of exact
 * hosts, never with a substring test - `youtube.com.evil.example` must not be
 * accepted. Only single YouTube videos are supported in this milestone.
 */
export type UnsupportedReason = 'playlist' | 'search' | 'not-youtube' | 'malformed';

export type ClassifiedInput =
  | {
      readonly kind: 'youtube-video';
      readonly videoId: string;
      /** Normalised watch URL handed to yt-dlp. */
      readonly canonicalUrl: string;
    }
  | { readonly kind: 'unsupported'; readonly reason: UnsupportedReason };

const WATCH_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function video(videoId: string): ClassifiedInput {
  return { kind: 'youtube-video', videoId, canonicalUrl: canonicalWatchUrl(videoId) };
}

function unsupported(reason: UnsupportedReason): ClassifiedInput {
  return { kind: 'unsupported', reason };
}

export function classifyInput(raw: string): ClassifiedInput {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return unsupported('malformed');
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Free text is not an error yet - it is simply not supported until the
    // search milestone lands.
    return unsupported(trimmed.includes('://') ? 'malformed' : 'search');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return unsupported('malformed');
  }

  const host = url.hostname.toLowerCase();

  if (SHORT_HOSTS.has(host)) {
    const id = url.pathname.slice(1);
    return VIDEO_ID.test(id) ? video(id) : unsupported('malformed');
  }

  if (!WATCH_HOSTS.has(host)) {
    return unsupported('not-youtube');
  }

  const path = url.pathname.replace(/\/+$/, '');
  const videoId = url.searchParams.get('v');

  // `watch?v=...&list=...` is deliberately treated as the single video it
  // points at; yt-dlp is called with --no-playlist so the list is ignored.
  if ((path === '/watch' || path === '/watch/') && videoId !== null) {
    return VIDEO_ID.test(videoId) ? video(videoId) : unsupported('malformed');
  }

  if (path === '/playlist' || url.searchParams.has('list')) {
    return unsupported('playlist');
  }

  if (path === '/results') {
    return unsupported('search');
  }

  return unsupported('malformed');
}

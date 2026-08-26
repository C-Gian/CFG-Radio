import type { Track } from '../player/track.js';
import type { PlayableSource } from '../player/transport.js';
import { parsePlayableSource } from '../audio/playable-source.js';
import { canonicalWatchUrl } from './url.js';
import { JS_RUNTIME_ARGS, type YtDlpRunner } from './ytdlp.js';

/**
 * Audio-only first, anything else as a last resort. FFmpeg re-encodes to
 * Ogg/Opus anyway, so the container does not matter.
 */
export const AUDIO_FORMAT_SELECTOR = 'bestaudio[acodec=opus]/bestaudio/best';

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

export { parsePlayableSource } from '../audio/playable-source.js';

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

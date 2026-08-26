import { resolveLocalTrack } from './local-catalog.js';
import type { Track } from '../player/track.js';
import type { PlaybackAttemptContext, PlayableSource, TrackResolver } from '../player/transport.js';
import { resolveYouTubePlayback } from '../youtube/playback.js';
import type { YtDlpRunner } from '../youtube/ytdlp.js';

export interface TrackResolverOptions {
  readonly ytdlp: YtDlpRunner;
}

/**
 * The composition point between a `Track` and the bytes FFmpeg reads.
 *
 * The player calls this only when a track is about to start (late resolution),
 * which is what keeps signed media URLs out of the queue. The switch is
 * exhaustive on purpose: adding a source makes the compiler point here.
 */
export function createTrackResolver(options: TrackResolverOptions): TrackResolver {
  return (track: Track, context: PlaybackAttemptContext): Promise<PlayableSource> => {
    switch (track.source) {
      case 'local':
        return resolveLocalTrack(track);
      case 'youtube':
        return resolveYouTubePlayback(options.ytdlp, track, { signal: context.signal });
    }
  };
}

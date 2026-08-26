import type { Track } from './track.js';

/**
 * What the transport should actually read.
 *
 * A local file today; a media URL handed over by a provider tomorrow. The
 * player never builds one of these itself - that is the resolver's job.
 */
export interface PlayableSource {
  readonly kind: 'file' | 'url';
  /** Passed to FFmpeg as its input: a local path, or a direct media URL. */
  readonly input: string;
  /**
   * HTTP headers FFmpeg must send with the request (yt-dlp hands over a
   * User-Agent and friends that keep YouTube from answering 403).
   *
   * Runtime only: a `PlayableSource` is never stored on a track or queued.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Turns the logical identity of a track into something playable. */
export type TrackResolver = (track: Track) => Promise<PlayableSource> | PlayableSource;

/**
 * The playback surface the orchestration layer depends on.
 *
 * `VoiceSession` implements it for real (Discord voice + AudioPlayer + FFmpeg);
 * the tests implement it with a fake, so queue and player logic can be checked
 * without a voice connection.
 */
export interface PlaybackTransport {
  /** Starts `source`, replacing whatever was playing. Rejects if it cannot start. */
  play(source: PlayableSource): Promise<void>;
  /** @returns `true` when the transport actually moved to paused. */
  pause(): boolean;
  /** @returns `true` when the transport actually resumed. */
  resume(): boolean;
  /** Changes live output gain. `volume` is a scalar from 0 (mute) to 1. */
  setVolume(volume: number): void;
  /** Stops playback and releases the pipeline. Idempotent, never emits a track end. */
  stopPlayback(): void;
  /** Registers the listener notified when a track ends *on its own*. */
  onTrackEnd(listener: () => void): void;
  /** Registers the listener notified when playback breaks unexpectedly. */
  onPlaybackError(listener: (error: unknown) => void): void;
}

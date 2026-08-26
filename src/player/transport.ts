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

/**
 * What a resolver is allowed to know about the attempt it serves.
 *
 * The signal belongs to one playback attempt in one guild: aborting it must
 * never touch another track, another guild or an unrelated child process.
 */
export interface PlaybackAttemptContext {
  readonly signal: AbortSignal;
}

/** Turns the logical identity of a track into something playable. */
export type TrackResolver = (
  track: Track,
  context: PlaybackAttemptContext,
) => Promise<PlayableSource> | PlayableSource;

/** Where the primary playback attempt failed before a track became current. */
export type PlaybackFailureStage = 'resolution' | 'start';

export interface PlaybackFallbackRequest {
  readonly track: Track;
  readonly stage: PlaybackFailureStage;
  readonly error: unknown;
  /** Aborted as soon as the attempt this fallback serves is superseded. */
  readonly signal: AbortSignal;
}

/**
 * Optionally resolves one alternative runtime source for a failed attempt.
 * Returning `undefined` means the original failure should stand.
 */
export type PlaybackFallbackResolver = (
  request: PlaybackFallbackRequest,
) => Promise<PlayableSource | undefined> | PlayableSource | undefined;

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

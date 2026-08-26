import { TrackQueue } from './queue.js';
import { describeTrack, type Track } from './track.js';
import type {
  PlaybackFallbackResolver,
  PlaybackFailureStage,
  PlaybackTransport,
  PlayableSource,
  TrackResolver,
} from './transport.js';
import type { Logger } from '../logger.js';

/**
 * How many tracks in a row may fail before the player gives up advancing.
 *
 * Prevents a queue full of broken entries from spinning forever; the remaining
 * tracks stay queued and `/skip` can restart the chain.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long an already resolved source may be used for an immediate start.
 *
 * Signed media URLs live for hours, so this only guards against a source that
 * waited behind an unusually long operation.
 */
export const IMMEDIATE_SOURCE_MAX_AGE_MS = 60_000;

class PlaybackCancelledError extends Error {
  constructor() {
    super('Playback attempt was cancelled by a control operation');
    this.name = 'PlaybackCancelledError';
  }
}

export type PlayerStatus = 'idle' | 'playing' | 'paused';
export type LoopMode = 'off' | 'track' | 'queue';

export type EnqueueResult =
  | { readonly kind: 'started'; readonly track: Track }
  | { readonly kind: 'queued'; readonly track: Track; readonly position: number }
  | { readonly kind: 'failed'; readonly track: Track; readonly error: unknown };

export type EnqueueManyResult =
  | { readonly kind: 'started'; readonly tracks: readonly Track[]; readonly track: Track }
  | {
      readonly kind: 'queued';
      readonly tracks: readonly Track[];
      readonly position: number;
    }
  | { readonly kind: 'failed'; readonly tracks: readonly Track[]; readonly error: unknown };

export type PauseResult = 'paused' | 'already-paused' | 'nothing-playing';
export type ResumeResult = 'resumed' | 'already-playing' | 'nothing-playing';
export type ShuffleResult = 'empty' | 'one-track' | 'shuffled';

export interface SkipResult {
  readonly skipped: Track | undefined;
  readonly next: Track | undefined;
}

export interface PlayerSnapshot {
  readonly status: PlayerStatus;
  readonly current: Track | undefined;
  readonly upcoming: readonly Track[];
  readonly volume: number;
  readonly loopMode: LoopMode;
}

export interface GuildPlayerOptions {
  readonly guildId: string;
  readonly transport: PlaybackTransport;
  readonly resolve: TrackResolver;
  readonly resolveFallback?: PlaybackFallbackResolver;
  readonly logger: Logger;
  readonly defaultVolume?: number;
  /** Reports transitions into and out of true voice-idle state. */
  readonly onIdleChange?: (idle: boolean) => void;
}

/**
 * Queue and playback orchestration for one guild.
 *
 * It owns the queue, the current track and the playback state, and drives the
 * transport - which stays responsible for Discord voice, the audio player and
 * FFmpeg. It knows nothing about how a track is streamed.
 *
 * Every state changing operation runs through a single promise chain, so two
 * interactions arriving at the same moment (or an auto-next racing a `/skip`)
 * can never interleave halfway.
 */
export class GuildPlayer {
  readonly guildId: string;

  private readonly queue = new TrackQueue();
  private readonly transport: PlaybackTransport;
  private readonly resolve: TrackResolver;
  private readonly resolveFallback: PlaybackFallbackResolver | undefined;
  private readonly logger: Logger;
  private readonly onIdleChange: ((idle: boolean) => void) | undefined;

  private currentTrack: Track | undefined;
  private status: PlayerStatus = 'idle';
  private volume: number;
  private loopMode: LoopMode = 'off';
  /** Distinguishes repeated playbacks of the same logical Track in loop modes. */
  private playbackGeneration = 0;
  /** Invalidates a source that is still resolving/starting when a control arrives. */
  private playbackAttemptEpoch = 0;
  private destroyed = false;
  private operationInProgress = false;
  private lastReportedIdle: boolean | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: GuildPlayerOptions) {
    this.guildId = options.guildId;
    this.transport = options.transport;
    this.resolve = options.resolve;
    this.resolveFallback = options.resolveFallback;
    this.logger = options.logger;
    this.onIdleChange = options.onIdleChange;
    this.volume = options.defaultVolume ?? 100;
    assertVolume(this.volume);
    this.transport.setVolume(this.volume / 100);

    this.transport.onTrackEnd(() => {
      // Captured now: by the time the operation runs, `/stop` or `/skip` may
      // have moved on, and a stale end event must not advance the queue.
      const ended = this.currentTrack;
      if (ended === undefined) {
        return;
      }
      const generation = this.playbackGeneration;
      void this.serialize(() => this.handleTrackEnd(ended, generation));
    });

    this.transport.onPlaybackError((error) => {
      const failed = this.currentTrack;
      const generation = this.playbackGeneration;
      void this.serialize(() => this.handlePlaybackError(failed, generation, error));
    });
  }

  get current(): Track | undefined {
    return this.currentTrack;
  }

  snapshot(): PlayerSnapshot {
    return {
      status: this.status,
      current: this.currentTrack,
      upcoming: this.queue.list(),
      volume: this.volume,
      loopMode: this.loopMode,
    };
  }

  /** True only when no current, queued or starting playback exists. */
  get isIdle(): boolean {
    return (
      !this.destroyed &&
      !this.operationInProgress &&
      this.currentTrack === undefined &&
      this.queue.isEmpty
    );
  }

  /** Resolves once every pending operation has settled. */
  whenSettled(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Starts `track` when the player is idle, queues it otherwise.
   *
   * A paused player keeps its queue growing without resuming: that is an
   * explicit `/resume`.
   */
  enqueue(track: Track, immediateSource?: PlayableSource): Promise<EnqueueResult> {
    const offeredAt = Date.now();
    return this.serialize(async () => {
      if (this.destroyed) {
        return { kind: 'failed', track, error: new Error('The player is shutting down') };
      }

      if (this.status === 'idle' && this.currentTrack === undefined && this.queue.isEmpty) {
        // A queued track is always resolved late; only a track starting right
        // now may reuse the source its command already fetched.
        const fresh =
          immediateSource !== undefined && Date.now() - offeredAt <= IMMEDIATE_SOURCE_MAX_AGE_MS
            ? immediateSource
            : undefined;
        const error = await this.startTrack(track, fresh);
        if (error === undefined) {
          return { kind: 'started', track };
        }
        return { kind: 'failed', track, error };
      }

      const position = this.queue.enqueue(track);
      this.logger.info(
        `Queued ${describeTrack(track)} at position ${position} in guild ${this.guildId}`,
      );
      return { kind: 'queued', track, position };
    });
  }

  /**
   * Atomically appends a FIFO batch. If idle, only its first playable track is
   * resolved now; every later track remains a logical identity in the queue.
   */
  enqueueMany(tracks: readonly Track[]): Promise<EnqueueManyResult> {
    const batch = [...tracks];
    return this.serialize(async () => {
      if (this.destroyed || batch.length === 0) {
        return {
          kind: 'failed',
          tracks: batch,
          error: new Error(this.destroyed ? 'The player is shutting down' : 'The batch is empty'),
        };
      }

      const canStart =
        this.status === 'idle' && this.currentTrack === undefined && this.queue.isEmpty;
      const position = this.queue.enqueueMany(batch);
      if (position === undefined) {
        return { kind: 'failed', tracks: batch, error: new Error('The batch is empty') };
      }

      this.logger.info(
        `Queued batch of ${batch.length} track(s) at position ${position} in guild ${this.guildId}`,
      );

      if (!canStart) {
        return { kind: 'queued', tracks: batch, position };
      }

      await this.advance();
      return this.currentTrack === undefined
        ? {
            kind: 'failed',
            tracks: batch,
            error: new Error('None of the first playlist tracks could be started'),
          }
        : { kind: 'started', tracks: batch, track: this.currentTrack };
    });
  }

  pause(): Promise<PauseResult> {
    return this.serialize(() => {
      if (this.currentTrack === undefined) {
        return Promise.resolve('nothing-playing');
      }
      if (this.status === 'paused') {
        return Promise.resolve('already-paused');
      }
      if (!this.transport.pause()) {
        return Promise.resolve('nothing-playing');
      }
      this.status = 'paused';
      this.logger.info(`Paused playback in guild ${this.guildId}`);
      return Promise.resolve('paused');
    });
  }

  resume(): Promise<ResumeResult> {
    return this.serialize(() => {
      if (this.currentTrack === undefined) {
        return Promise.resolve('nothing-playing');
      }
      if (this.status === 'playing') {
        return Promise.resolve('already-playing');
      }
      if (!this.transport.resume()) {
        return Promise.resolve('nothing-playing');
      }
      this.status = 'playing';
      this.logger.info(`Resumed playback in guild ${this.guildId}`);
      return Promise.resolve('resumed');
    });
  }

  /** Applies and retains a per-session volume percentage. */
  setVolume(level: number): Promise<number> {
    assertVolume(level);
    return this.serialize(() => {
      this.volume = level;
      this.transport.setVolume(level / 100);
      this.logger.info(`Volume changed in guild ${this.guildId}: ${level}%`);
      return Promise.resolve(level);
    });
  }

  /** Randomises only the upcoming FIFO tracks; current playback is untouched. */
  shuffle(random: () => number = Math.random): Promise<ShuffleResult> {
    return this.serialize(() => {
      if (this.queue.isEmpty) {
        return Promise.resolve('empty');
      }
      if (this.queue.size === 1) {
        return Promise.resolve('one-track');
      }
      this.queue.shuffle(random);
      this.logger.info(`Queue shuffled in guild ${this.guildId}: ${this.queue.size} track(s)`);
      return Promise.resolve('shuffled');
    });
  }

  setLoopMode(mode: LoopMode): Promise<LoopMode> {
    return this.serialize(() => {
      this.loopMode = mode;
      this.logger.info(`Loop changed in guild ${this.guildId}: ${mode}`);
      return Promise.resolve(mode);
    });
  }

  /**
   * Ends the current track and starts the next one, if any.
   *
   * The transport stop below cannot trigger an auto-next: `currentTrack` is
   * cleared first, so a late end event is recognised as stale.
   */
  skip(): Promise<SkipResult> {
    this.playbackAttemptEpoch += 1;
    return this.serialize(async () => {
      const skipped = this.currentTrack;
      this.currentTrack = undefined;
      this.status = 'idle';
      this.transport.stopPlayback();

      if (skipped !== undefined) {
        this.logger.info(`Skipped ${describeTrack(skipped)} in guild ${this.guildId}`);
      }

      await this.advance();
      return { skipped, next: this.currentTrack };
    });
  }

  /**
   * Stops playback and empties the queue, keeping the voice connection.
   *
   * @returns `true` when there was something to stop.
   */
  stop(): Promise<boolean> {
    this.playbackAttemptEpoch += 1;
    return this.serialize(() => {
      const hadSomething =
        this.currentTrack !== undefined || !this.queue.isEmpty || this.loopMode !== 'off';

      this.currentTrack = undefined;
      this.status = 'idle';
      this.queue.clear();
      this.loopMode = 'off';
      this.transport.stopPlayback();

      if (hadSomething) {
        this.logger.info(`Stopped playback and cleared the queue in guild ${this.guildId}`);
      }
      return Promise.resolve(hadSomething);
    });
  }

  /**
   * Permanently shuts the player down: no further track can start.
   *
   * Idempotent - the voice session and the process shutdown both call it.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.playbackAttemptEpoch += 1;
    this.currentTrack = undefined;
    this.status = 'idle';
    this.queue.clear();
    this.loopMode = 'off';
    this.transport.stopPlayback();
    this.logger.debug(`Player destroyed in guild ${this.guildId}`);
  }

  /** Runs `operation` after every previously scheduled one. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.operationInProgress = true;
      this.reportIdleChange();
      try {
        return await operation();
      } finally {
        this.operationInProgress = false;
        this.reportIdleChange();
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async handleTrackEnd(ended: Track, generation: number): Promise<void> {
    if (this.destroyed || this.currentTrack !== ended || this.playbackGeneration !== generation) {
      // Superseded by /skip, /stop or a disconnect while we were queued.
      return;
    }

    this.logger.info(`Finished ${describeTrack(ended)} in guild ${this.guildId}`);
    this.currentTrack = undefined;
    this.status = 'idle';

    if (this.loopMode === 'track') {
      this.logger.info(`Natural track-loop restart in guild ${this.guildId}`);
      const error = await this.startTrack(ended);
      if (error === undefined || error instanceof PlaybackCancelledError) {
        // Cancelled means a control operation is already queued behind us and
        // owns the transition: pulling the next track forward here would make
        // a single /skip consume two tracks.
        return;
      }
      // One failed replay is enough: do not turn an unavailable track into an
      // infinite retry loop. Continue with ordinary queued playback instead.
      await this.advance();
      return;
    }

    if (this.loopMode === 'queue') {
      this.queue.enqueue(ended);
      this.logger.info(`Queue-loop re-enqueued a completed track in guild ${this.guildId}`);
    }
    await this.advance();
  }

  private async handlePlaybackError(
    failed: Track | undefined,
    generation: number,
    error: unknown,
  ): Promise<void> {
    if (
      this.destroyed ||
      failed === undefined ||
      this.currentTrack !== failed ||
      this.playbackGeneration !== generation
    ) {
      // Nothing was playing, or the failure belongs to a superseded track.
      return;
    }

    this.logger.error(
      `Playback failed for ${describeTrack(failed)} in guild ${this.guildId}`,
      error,
    );
    this.currentTrack = undefined;
    this.status = 'idle';
    this.transport.stopPlayback();
    await this.advance();
  }

  /** Starts the next queued track, or leaves the player idle. */
  private async advance(attempt = 0): Promise<void> {
    if (this.destroyed) {
      return;
    }

    const next = this.queue.dequeue();
    if (next === undefined) {
      this.status = 'idle';
      this.logger.debug(`Queue empty in guild ${this.guildId}, player is idle`);
      return;
    }

    this.logger.debug(`Auto-next in guild ${this.guildId}: ${describeTrack(next)}`);
    const error = await this.startTrack(next);
    if (error === undefined) {
      return;
    }
    if (error instanceof PlaybackCancelledError) {
      return;
    }

    if (attempt + 1 >= MAX_CONSECUTIVE_FAILURES) {
      this.logger.warn(
        `Giving up after ${MAX_CONSECUTIVE_FAILURES} consecutive playback failures in guild ` +
          `${this.guildId}; ${this.queue.size} track(s) left queued`,
      );
      return;
    }
    await this.advance(attempt + 1);
  }

  /**
   * Resolves and starts a track.
   *
   * @returns `undefined` on success, or the error that prevented playback.
   */
  private async startTrack(track: Track, immediateSource?: PlayableSource): Promise<unknown> {
    const attemptEpoch = this.playbackAttemptEpoch;
    let source: PlayableSource;
    if (immediateSource !== undefined) {
      source = immediateSource;
    } else {
      try {
        source = await this.resolve(track);
      } catch (error) {
        return this.tryFallback(track, 'resolution', error, attemptEpoch);
      }
    }

    if (!this.isAttemptCurrent(attemptEpoch)) {
      return this.failStart(track, new PlaybackCancelledError());
    }

    try {
      await this.transport.play(source);
    } catch (error) {
      this.transport.stopPlayback();
      return this.tryFallback(track, 'start', error, attemptEpoch);
    }
    return this.finishStart(track, attemptEpoch);
  }

  private async tryFallback(
    track: Track,
    stage: PlaybackFailureStage,
    primaryError: unknown,
    attemptEpoch: number,
  ): Promise<unknown> {
    if (this.resolveFallback === undefined || !this.isAttemptCurrent(attemptEpoch)) {
      return this.failStart(track, primaryError);
    }

    let fallbackSource: PlayableSource | undefined;
    try {
      fallbackSource = await this.resolveFallback({ track, stage, error: primaryError });
    } catch (error) {
      this.logger.warn(`Playback fallback evaluation failed for ${describeTrack(track)}`, error);
      return this.failStart(track, primaryError);
    }
    if (!this.isAttemptCurrent(attemptEpoch)) {
      return this.failStart(track, new PlaybackCancelledError());
    }
    if (fallbackSource === undefined) {
      return this.failStart(track, primaryError);
    }

    try {
      await this.transport.play(fallbackSource);
    } catch (error) {
      this.transport.stopPlayback();
      this.logger.error(`Fallback could not start for ${describeTrack(track)}`, error);
      return this.failStart(track, primaryError);
    }
    return this.finishStart(track, attemptEpoch);
  }

  private finishStart(track: Track, attemptEpoch: number): unknown {
    if (!this.isAttemptCurrent(attemptEpoch)) {
      this.transport.stopPlayback();
      return this.failStart(track, new PlaybackCancelledError());
    }
    this.currentTrack = track;
    this.playbackGeneration += 1;
    this.status = 'playing';
    this.logger.info(`Started ${describeTrack(track)} in guild ${this.guildId}`);
    return undefined;
  }

  private failStart(track: Track, error: unknown): unknown {
    this.logger.error(`Could not play ${describeTrack(track)} in guild ${this.guildId}`, error);
    this.currentTrack = undefined;
    this.status = 'idle';
    this.transport.stopPlayback();
    return error;
  }

  private isAttemptCurrent(attemptEpoch: number): boolean {
    return !this.destroyed && this.playbackAttemptEpoch === attemptEpoch;
  }

  private reportIdleChange(): void {
    const idle = this.isIdle;
    if (idle === this.lastReportedIdle) {
      return;
    }
    this.lastReportedIdle = idle;
    this.onIdleChange?.(idle);
  }
}

function assertVolume(level: number): void {
  if (!Number.isInteger(level) || level < 0 || level > 100) {
    throw new RangeError('Volume must be an integer between 0 and 100');
  }
}

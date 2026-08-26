import { TrackQueue } from './queue.js';
import { describeTrack, type Track } from './track.js';
import type { PlaybackTransport, TrackResolver } from './transport.js';
import type { Logger } from '../logger.js';

/**
 * How many tracks in a row may fail before the player gives up advancing.
 *
 * Prevents a queue full of broken entries from spinning forever; the remaining
 * tracks stay queued and `/skip` can restart the chain.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

export type PlayerStatus = 'idle' | 'playing' | 'paused';

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

export interface SkipResult {
  readonly skipped: Track | undefined;
  readonly next: Track | undefined;
}

export interface PlayerSnapshot {
  readonly status: PlayerStatus;
  readonly current: Track | undefined;
  readonly upcoming: readonly Track[];
}

export interface GuildPlayerOptions {
  readonly guildId: string;
  readonly transport: PlaybackTransport;
  readonly resolve: TrackResolver;
  readonly logger: Logger;
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
  private readonly logger: Logger;

  private currentTrack: Track | undefined;
  private status: PlayerStatus = 'idle';
  private destroyed = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: GuildPlayerOptions) {
    this.guildId = options.guildId;
    this.transport = options.transport;
    this.resolve = options.resolve;
    this.logger = options.logger;

    this.transport.onTrackEnd(() => {
      // Captured now: by the time the operation runs, `/stop` or `/skip` may
      // have moved on, and a stale end event must not advance the queue.
      const ended = this.currentTrack;
      if (ended === undefined) {
        return;
      }
      void this.serialize(() => this.handleTrackEnd(ended));
    });

    this.transport.onPlaybackError((error) => {
      const failed = this.currentTrack;
      void this.serialize(() => this.handlePlaybackError(failed, error));
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
    };
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
  enqueue(track: Track): Promise<EnqueueResult> {
    return this.serialize(async () => {
      if (this.destroyed) {
        return { kind: 'failed', track, error: new Error('The player is shutting down') };
      }

      if (this.status === 'idle' && this.currentTrack === undefined && this.queue.isEmpty) {
        const error = await this.startTrack(track);
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

  pause(): PauseResult {
    if (this.currentTrack === undefined) {
      return 'nothing-playing';
    }
    if (this.status === 'paused') {
      return 'already-paused';
    }
    if (!this.transport.pause()) {
      return 'nothing-playing';
    }
    this.status = 'paused';
    this.logger.info(`Paused playback in guild ${this.guildId}`);
    return 'paused';
  }

  resume(): ResumeResult {
    if (this.currentTrack === undefined) {
      return 'nothing-playing';
    }
    if (this.status === 'playing') {
      return 'already-playing';
    }
    if (!this.transport.resume()) {
      return 'nothing-playing';
    }
    this.status = 'playing';
    this.logger.info(`Resumed playback in guild ${this.guildId}`);
    return 'resumed';
  }

  /**
   * Ends the current track and starts the next one, if any.
   *
   * The transport stop below cannot trigger an auto-next: `currentTrack` is
   * cleared first, so a late end event is recognised as stale.
   */
  skip(): Promise<SkipResult> {
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
    return this.serialize(() => {
      const hadSomething = this.currentTrack !== undefined || !this.queue.isEmpty;

      this.currentTrack = undefined;
      this.status = 'idle';
      this.queue.clear();
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
    this.currentTrack = undefined;
    this.status = 'idle';
    this.queue.clear();
    this.transport.stopPlayback();
    this.logger.debug(`Player destroyed in guild ${this.guildId}`);
  }

  /** Runs `operation` after every previously scheduled one. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async handleTrackEnd(ended: Track): Promise<void> {
    if (this.destroyed || this.currentTrack !== ended) {
      // Superseded by /skip, /stop or a disconnect while we were queued.
      return;
    }

    this.logger.info(`Finished ${describeTrack(ended)} in guild ${this.guildId}`);
    this.currentTrack = undefined;
    this.status = 'idle';
    await this.advance();
  }

  private async handlePlaybackError(failed: Track | undefined, error: unknown): Promise<void> {
    if (this.destroyed || failed === undefined || this.currentTrack !== failed) {
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
  private async startTrack(track: Track): Promise<unknown> {
    try {
      const source = await this.resolve(track);
      if (this.isDestroyed()) {
        return new Error('The player was destroyed while resolving the track');
      }
      await this.transport.play(source);
      if (this.isDestroyed()) {
        this.transport.stopPlayback();
        return new Error('The player was destroyed while starting the track');
      }
      this.currentTrack = track;
      this.status = 'playing';
      this.logger.info(`Started ${describeTrack(track)} in guild ${this.guildId}`);
      return undefined;
    } catch (error) {
      this.logger.error(`Could not play ${describeTrack(track)} in guild ${this.guildId}`, error);
      // Leave nothing half-started behind. The slot is cleared first so a late
      // end event from the transport is recognised as stale.
      this.currentTrack = undefined;
      this.status = 'idle';
      this.transport.stopPlayback();
      return error;
    }
  }

  private isDestroyed(): boolean {
    return this.destroyed;
  }
}

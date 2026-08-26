import type { Track } from './track.js';

/**
 * A plain FIFO queue of tracks.
 *
 * Pure on purpose: no Discord, no voice, no FFmpeg, no filesystem, no clock.
 * Everything the player does with ordering is decided here and can be tested
 * in isolation.
 */
export class TrackQueue {
  private readonly tracks: Track[] = [];

  get size(): number {
    return this.tracks.length;
  }

  get isEmpty(): boolean {
    return this.tracks.length === 0;
  }

  /** Appends a track and returns its 1-based position in the queue. */
  enqueue(track: Track): number {
    return this.tracks.push(track);
  }

  /** Appends a batch without changing its order; returns the first position. */
  enqueueMany(tracks: readonly Track[]): number | undefined {
    if (tracks.length === 0) {
      return undefined;
    }
    const firstPosition = this.tracks.length + 1;
    this.tracks.push(...tracks);
    return firstPosition;
  }

  /** Removes and returns the head, or `undefined` when empty. */
  dequeue(): Track | undefined {
    return this.tracks.shift();
  }

  /** The next track that would be dequeued, without removing it. */
  peek(): Track | undefined {
    return this.tracks[0];
  }

  clear(): void {
    this.tracks.length = 0;
  }

  /** Randomises upcoming tracks in place with an unbiased Fisher-Yates pass. */
  shuffle(random: () => number = Math.random): void {
    for (let index = this.tracks.length - 1; index > 0; index -= 1) {
      const value = random();
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError('The shuffle random source must return a value from 0 up to 1');
      }
      const other = Math.floor(value * (index + 1));
      const currentTrack = this.tracks[index];
      const otherTrack = this.tracks[other];
      if (currentTrack === undefined || otherTrack === undefined) {
        throw new Error('Queue changed unexpectedly while it was being shuffled');
      }
      this.tracks[index] = otherTrack;
      this.tracks[other] = currentTrack;
    }
  }

  /**
   * A read-only copy of the pending tracks, in play order.
   *
   * Callers get a snapshot: mutating it cannot corrupt the queue.
   */
  list(): readonly Track[] {
    return [...this.tracks];
  }
}

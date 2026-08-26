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

  /**
   * A read-only copy of the pending tracks, in play order.
   *
   * Callers get a snapshot: mutating it cannot corrupt the queue.
   */
  list(): readonly Track[] {
    return [...this.tracks];
  }
}

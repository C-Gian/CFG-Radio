import { describe, expect, it } from 'vitest';

import { TrackQueue } from '../src/player/queue.js';
import { createTrack, type Track } from '../src/player/track.js';

function track(title: string): Track {
  return createTrack({
    title,
    source: 'local',
    sourceId: title,
    originalInput: title,
    requestedByUserId: 'user-1',
    durationMs: 8000,
  });
}

describe('TrackQueue', () => {
  it('starts empty', () => {
    const queue = new TrackQueue();

    expect(queue.size).toBe(0);
    expect(queue.isEmpty).toBe(true);
    expect(queue.peek()).toBeUndefined();
    expect(queue.dequeue()).toBeUndefined();
    expect(queue.list()).toEqual([]);
  });

  it('returns the 1-based position on enqueue', () => {
    const queue = new TrackQueue();

    expect(queue.enqueue(track('a'))).toBe(1);
    expect(queue.enqueue(track('b'))).toBe(2);
    expect(queue.size).toBe(2);
    expect(queue.isEmpty).toBe(false);
  });

  it('dequeues in FIFO order', () => {
    const queue = new TrackQueue();
    const [a, b, c] = [track('a'), track('b'), track('c')];
    queue.enqueue(a);
    queue.enqueue(b);
    queue.enqueue(c);

    expect(queue.dequeue()).toBe(a);
    expect(queue.dequeue()).toBe(b);
    expect(queue.dequeue()).toBe(c);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('peeks at the head without removing it', () => {
    const queue = new TrackQueue();
    const a = track('a');
    queue.enqueue(a);
    queue.enqueue(track('b'));

    expect(queue.peek()).toBe(a);
    expect(queue.size).toBe(2);
    expect(queue.dequeue()).toBe(a);
  });

  it('keeps the same track twice as two distinct entries', () => {
    const queue = new TrackQueue();
    const first = track('same');
    const second = track('same');
    queue.enqueue(first);
    queue.enqueue(second);

    expect(first.id).not.toBe(second.id);
    expect(queue.list().map((entry) => entry.id)).toEqual([first.id, second.id]);
  });

  it('clears everything', () => {
    const queue = new TrackQueue();
    queue.enqueue(track('a'));
    queue.enqueue(track('b'));

    queue.clear();

    expect(queue.size).toBe(0);
    expect(queue.isEmpty).toBe(true);
    expect(queue.list()).toEqual([]);
  });

  it('hands out a snapshot that cannot mutate the queue', () => {
    const queue = new TrackQueue();
    queue.enqueue(track('a'));
    queue.enqueue(track('b'));

    const snapshot = queue.list() as Track[];
    snapshot.pop();
    snapshot.push(track('injected'));

    expect(queue.size).toBe(2);
    expect(queue.list().map((entry) => entry.title)).toEqual(['a', 'b']);
  });

  it('goes empty -> non-empty -> empty', () => {
    const queue = new TrackQueue();
    expect(queue.isEmpty).toBe(true);

    queue.enqueue(track('a'));
    expect(queue.isEmpty).toBe(false);

    queue.dequeue();
    expect(queue.isEmpty).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('shuffles deterministically while preserving every identity exactly once', () => {
    const queue = new TrackQueue();
    const entries = [track('a'), track('b'), track('c'), track('d')];
    queue.enqueueMany(entries);

    queue.shuffle(() => 0);

    expect(queue.list()).toEqual([entries[1], entries[2], entries[3], entries[0]]);
    expect(new Set(queue.list())).toEqual(new Set(entries));
  });

  it('leaves empty and one-item queues unchanged', () => {
    const queue = new TrackQueue();
    queue.shuffle(() => 0);
    const only = track('only');
    queue.enqueue(only);
    queue.shuffle(() => 0);
    expect(queue.list()).toEqual([only]);
  });

  it('rejects an invalid injected random source', () => {
    const queue = new TrackQueue();
    queue.enqueueMany([track('a'), track('b')]);
    expect(() => {
      queue.shuffle(() => 1);
    }).toThrow(/random source/);
  });
});

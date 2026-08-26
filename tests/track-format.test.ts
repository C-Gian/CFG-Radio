import { describe, expect, it } from 'vitest';

import type { LoopMode, PlayerSnapshot, PlayerStatus } from '../src/player/guild-player.js';
import { createTrack, type Track } from '../src/player/track.js';
import {
  QUEUE_PAGE_SIZE,
  formatDuration,
  formatNowPlaying,
  formatQueue,
} from '../src/discord/track-format.js';

function track(title: string, durationMs: number | undefined = 8000, user = 'user-1'): Track {
  return createTrack({
    title,
    source: 'local',
    sourceId: title,
    originalInput: title,
    requestedByUserId: user,
    durationMs,
  });
}

function snapshot(
  current: Track | undefined,
  upcoming: readonly Track[] = [],
  status: PlayerStatus = 'playing',
  volume = 50,
  loopMode: LoopMode = 'off',
): PlayerSnapshot {
  return { status, current, upcoming, volume, loopMode };
}

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [8000, '0:08'],
    [65_000, '1:05'],
    [3_600_000, '1:00:00'],
    [3_725_000, '1:02:05'],
  ])('formats %sms as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('falls back for unknown or invalid durations', () => {
    expect(formatDuration(undefined)).toBe('unknown length');
    expect(formatDuration(-1)).toBe('unknown length');
    expect(formatDuration(Number.NaN)).toBe('unknown length');
  });
});

describe('formatNowPlaying', () => {
  it('reports an empty player', () => {
    expect(formatNowPlaying(snapshot(undefined))).toContain('Nothing is playing');
  });

  it('shows title, length, requester and queue size', () => {
    const message = formatNowPlaying(snapshot(track('Arpeggio'), [track('Next')]));

    expect(message).toContain('Arpeggio');
    expect(message).toContain('0:08');
    expect(message).toContain('<@user-1>');
    expect(message).toContain('1 track(s)');
  });

  it('shows the paused state', () => {
    expect(formatNowPlaying(snapshot(track('Arpeggio'), [], 'paused'))).toContain('Paused');
  });

  it('shows current volume and a non-off loop mode compactly', () => {
    const message = formatNowPlaying(snapshot(track('Arpeggio'), [], 'playing', 65, 'track'));

    expect(message).toContain('Volume: **65%**');
    expect(message).toContain('Loop: **Track**');
  });

  it('handles a track of unknown length', () => {
    const unknown = createTrack({
      title: 'Live',
      source: 'local',
      sourceId: 'live',
      originalInput: 'live',
      requestedByUserId: 'user-1',
    });

    expect(formatNowPlaying(snapshot(unknown))).toContain('unknown length');
  });
});

describe('formatQueue', () => {
  it('reports an empty queue with nothing playing', () => {
    expect(formatQueue(snapshot(undefined))).toBe('The queue is empty and nothing is playing.');
  });

  it('shows the current track and says the queue is empty', () => {
    const message = formatQueue(snapshot(track('Arpeggio')));

    expect(message).toContain('Arpeggio');
    expect(message).toContain('Nothing queued after this one.');
  });

  it('numbers the upcoming tracks in FIFO order', () => {
    const message = formatQueue(
      snapshot(track('Current'), [track('First'), track('Second'), track('Third')]),
    );

    expect(message).toContain('**Queue (3):**');
    expect(message).toMatch(/1\. \*\*First\*\*/);
    expect(message).toMatch(/2\. \*\*Second\*\*/);
    expect(message).toMatch(/3\. \*\*Third\*\*/);
  });

  it('truncates a long queue and says how many are hidden', () => {
    const upcoming = Array.from({ length: QUEUE_PAGE_SIZE + 5 }, (_value, index) =>
      track(`Track ${index}`),
    );

    const message = formatQueue(snapshot(track('Current'), upcoming));

    expect(message).toContain(`**Queue (${QUEUE_PAGE_SIZE + 5}):**`);
    expect(message).toContain('...and 5 more.');
    expect(message).not.toContain(`${QUEUE_PAGE_SIZE + 1}. `);
  });

  it('lists the queue even when nothing is playing', () => {
    const message = formatQueue(snapshot(undefined, [track('Waiting')], 'idle'));

    expect(message).toContain('**Now playing:** nothing');
    expect(message).toContain('1. **Waiting**');
  });

  it('stays comfortably below the Discord message limit', () => {
    const upcoming = Array.from({ length: 100 }, (_value, index) => track(`Track ${index}`));

    expect(formatQueue(snapshot(track('Current'), upcoming)).length).toBeLessThan(2000);
  });

  it('adds volume and loop settings without changing FIFO content', () => {
    const message = formatQueue(
      snapshot(track('Current'), [track('First')], 'playing', 0, 'queue'),
    );

    expect(message).toContain('1. **First**');
    expect(message).toContain('Volume: **0%**');
    expect(message).toContain('Loop: **Queue**');
  });
});

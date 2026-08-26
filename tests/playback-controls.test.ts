import { describe, expect, it, vi } from 'vitest';

import { GuildPlayer } from '../src/player/guild-player.js';
import type { Track } from '../src/player/track.js';
import type { PlayableSource } from '../src/player/transport.js';
import { FakeTransport, fakeLogger, fakeResolver, localTrack } from './helpers/fake-transport.js';

function createPlayer(defaultVolume = 100) {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const resolve = vi.fn(fakeResolver);
  const player = new GuildPlayer({
    guildId: 'guild-1',
    transport,
    resolve,
    logger,
    defaultVolume,
  });
  return { player, transport, resolve, logger };
}

describe('GuildPlayer volume', () => {
  it('applies the configured default and exposes it', () => {
    const { player, transport } = createPlayer(37);

    expect(player.snapshot().volume).toBe(37);
    expect(transport.volume).toBe(0.37);
  });

  it.each([0, 1, 50, 100])('sets %i%% live on the current source', async (level) => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));

    await expect(player.setVolume(level)).resolves.toBe(level);

    expect(player.snapshot().volume).toBe(level);
    expect(transport.volume).toBe(level / 100);
  });

  it.each([-1, 101, 1.5, Number.NaN])('rejects invalid level %s defensively', (level) => {
    const { player } = createPlayer();
    expect(() => player.setVolume(level)).toThrow(/integer between 0 and 100/);
  });

  it('keeps volume through next, skip, pause/resume and stop/new play', async () => {
    const { player, transport } = createPlayer(25);
    await player.enqueueMany([localTrack('a'), localTrack('b'), localTrack('c')]);
    await player.setVolume(60);
    await player.pause();
    await player.resume();

    transport.finishTrack();
    await player.whenSettled();
    await player.skip();
    await player.stop();
    await player.enqueue(localTrack('d'));

    expect(transport.playedVolumes).toEqual([0.25, 0.6, 0.6, 0.6]);
    expect(player.snapshot().volume).toBe(60);
  });
});

describe('GuildPlayer shuffle', () => {
  it('handles an empty and a one-track upcoming queue cleanly', async () => {
    const { player } = createPlayer();
    expect(await player.shuffle()).toBe('empty');

    await player.enqueueMany([localTrack('a'), localTrack('b')]);
    expect(await player.shuffle()).toBe('one-track');
  });

  it('uses deterministic Fisher-Yates without changing current or membership', async () => {
    const { player } = createPlayer();
    const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id) => localTrack(id)) as [
      Track,
      Track,
      Track,
      Track,
      Track,
    ];
    await player.enqueueMany([a, b, c, d, e]);
    const before = player.snapshot().upcoming;

    expect(await player.shuffle(() => 0)).toBe('shuffled');

    const after = player.snapshot().upcoming;
    expect(player.current).toBe(a);
    expect(after).toEqual([c, d, e, b]);
    expect(new Set(after)).toEqual(new Set(before));
    expect(after).toHaveLength(before.length);
  });

  it('plays the shuffled order as the new FIFO', async () => {
    const { player, transport } = createPlayer();
    await player.enqueueMany(['a', 'b', 'c', 'd'].map((id) => localTrack(id)));
    await player.shuffle(() => 0);

    for (let index = 0; index < 3; index += 1) {
      transport.finishTrack();
      await player.whenSettled();
    }

    expect(transport.played.map((source) => source.input)).toEqual([
      'a.opus',
      'c.opus',
      'd.opus',
      'b.opus',
    ]);
  });
});

describe('GuildPlayer track loop', () => {
  it('re-resolves and replays the same logical track after a natural end', async () => {
    const transport = new FakeTransport();
    const track = localTrack('a');
    let resolution = 0;
    const resolve = vi.fn((): PlayableSource => ({
      kind: 'url',
      input: `ephemeral-${++resolution}`,
    }));
    const player = new GuildPlayer({
      guildId: 'guild-1',
      transport,
      resolve,
      logger: fakeLogger(),
    });
    await player.enqueue(track);
    await player.setLoopMode('track');

    transport.finishTrack();
    await player.whenSettled();

    expect(player.current).toBe(track);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.played.map((source) => source.input)).toEqual(['ephemeral-1', 'ephemeral-2']);
    expect(JSON.stringify(player.snapshot())).not.toContain('ephemeral-');
  });

  it('skip bypasses track loop and removes the skipped identity', async () => {
    const { player } = createPlayer();
    const [a, b, c] = [localTrack('a'), localTrack('b'), localTrack('c')];
    await player.enqueueMany([a, b, c]);
    await player.setLoopMode('track');

    const result = await player.skip();

    expect(result).toEqual({ skipped: a, next: b });
    expect(player.snapshot().upcoming).toEqual([c]);
  });

  it('a failed natural replay advances once instead of retrying forever', async () => {
    const transport = new FakeTransport();
    const a = localTrack('a');
    const b = localTrack('b');
    let aCalls = 0;
    const resolve = vi.fn((track: Track): PlayableSource | Promise<PlayableSource> => {
      if (track === a && ++aCalls > 1) {
        return Promise.reject(new Error('became unavailable'));
      }
      return fakeResolver(track);
    });
    const player = new GuildPlayer({
      guildId: 'guild-1',
      transport,
      resolve,
      logger: fakeLogger(),
    });
    await player.enqueueMany([a, b]);
    await player.setLoopMode('track');

    transport.finishTrack();
    await player.whenSettled();

    expect(aCalls).toBe(2);
    expect(player.current).toBe(b);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('a playback error bypasses track loop and advances', async () => {
    const { player, transport, resolve } = createPlayer();
    const [a, b] = [localTrack('a'), localTrack('b')];
    await player.enqueueMany([a, b]);
    await player.setLoopMode('track');

    transport.breakPlayback(new Error('FFmpeg failed'));
    await player.whenSettled();

    expect(player.current).toBe(b);
    expect(resolve.mock.calls.filter(([track]) => track === a)).toHaveLength(1);
  });

  it('ignores a duplicate stale end after the same logical track was restarted', async () => {
    const { player, transport, resolve } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.setLoopMode('track');

    transport.finishTrack();
    transport.finishTrack();
    await player.whenSettled();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(transport.played).toHaveLength(2);
  });
});

describe('GuildPlayer queue loop', () => {
  it('cycles successful natural completions at the tail by logical identity', async () => {
    const { player, transport, resolve } = createPlayer();
    const [a, b, c] = [localTrack('a'), localTrack('b'), localTrack('c')];
    await player.enqueueMany([a, b, c]);
    await player.setLoopMode('queue');

    transport.finishTrack();
    await player.whenSettled();
    expect(player.current).toBe(b);
    expect(player.snapshot().upcoming).toEqual([c, a]);

    transport.finishTrack();
    await player.whenSettled();
    expect(player.current).toBe(c);
    expect(player.snapshot().upcoming).toEqual([a, b]);

    transport.finishTrack();
    await player.whenSettled();
    expect(player.current).toBe(a);
    expect(resolve.mock.calls.filter(([track]) => track === a)).toHaveLength(2);
  });

  it('skip drops current from the cycle', async () => {
    const { player } = createPlayer();
    const [a, b, c] = [localTrack('a'), localTrack('b'), localTrack('c')];
    await player.enqueueMany([a, b, c]);
    await player.setLoopMode('queue');

    await player.skip();

    expect(player.current).toBe(b);
    expect(player.snapshot().upcoming).toEqual([c]);
    expect(player.snapshot().upcoming).not.toContain(a);
  });

  it('does not re-enqueue a playback failure', async () => {
    const { player, transport } = createPlayer();
    const [a, b, c] = [localTrack('a'), localTrack('b'), localTrack('c')];
    await player.enqueueMany([a, b, c]);
    await player.setLoopMode('queue');
    transport.finishTrack();
    await player.whenSettled();

    transport.breakPlayback();
    await player.whenSettled();

    expect(player.current).toBe(c);
    expect(player.snapshot().upcoming).toEqual([a]);
    expect(player.snapshot().upcoming).not.toContain(b);
  });

  it('stop clears playback and resets loop without resetting volume', async () => {
    const { player } = createPlayer();
    await player.enqueueMany([localTrack('a'), localTrack('b')]);
    await player.setVolume(40);
    await player.setLoopMode('queue');

    await player.stop();

    expect(player.snapshot()).toMatchObject({
      status: 'idle',
      current: undefined,
      upcoming: [],
      volume: 40,
      loopMode: 'off',
    });
  });
});

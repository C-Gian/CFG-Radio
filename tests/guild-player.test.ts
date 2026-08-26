import { describe, expect, it } from 'vitest';

import { GuildPlayer, MAX_CONSECUTIVE_FAILURES } from '../src/player/guild-player.js';
import { FakeTransport, fakeLogger, fakeResolver, localTrack } from './helpers/fake-transport.js';

function createPlayer() {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const player = new GuildPlayer({
    guildId: 'guild-1',
    transport,
    resolve: fakeResolver,
    logger,
  });
  return { player, transport, logger };
}

/** Lets the auto-next / failure operations scheduled by an event settle. */
async function settle(player: GuildPlayer): Promise<void> {
  await player.whenSettled();
}

describe('GuildPlayer - starting and queueing', () => {
  it('starts the first track immediately', async () => {
    const { player, transport } = createPlayer();
    const first = localTrack('a');

    const result = await player.enqueue(first);

    expect(result).toEqual({ kind: 'started', track: first });
    expect(player.current).toBe(first);
    expect(player.snapshot().status).toBe('playing');
    expect(transport.lastPlayed).toEqual({ kind: 'file', input: 'a.opus' });
  });

  it('queues the second track without interrupting the first', async () => {
    const { player, transport } = createPlayer();
    const first = localTrack('a');
    const second = localTrack('b');

    await player.enqueue(first);
    const result = await player.enqueue(second);

    expect(result).toEqual({ kind: 'queued', track: second, position: 1 });
    expect(player.current).toBe(first);
    expect(transport.played).toHaveLength(1);
    expect(player.snapshot().upcoming.map((track) => track.id)).toEqual([second.id]);
  });

  it('numbers queue positions in FIFO order', async () => {
    const { player } = createPlayer();
    await player.enqueue(localTrack('a'));

    const second = await player.enqueue(localTrack('b'));
    const third = await player.enqueue(localTrack('c'));

    expect(second).toMatchObject({ position: 1 });
    expect(third).toMatchObject({ position: 2 });
  });

  it('queues without resuming while paused', async () => {
    const { player, transport } = createPlayer();
    const first = localTrack('a');
    await player.enqueue(first);
    player.pause();

    const result = await player.enqueue(localTrack('b'));

    expect(result.kind).toBe('queued');
    expect(player.snapshot().status).toBe('paused');
    expect(transport.paused).toBe(true);
    expect(player.current).toBe(first);
  });

  it('serialises two simultaneous enqueues on an idle player', async () => {
    const { player, transport } = createPlayer();
    const first = localTrack('a');
    const second = localTrack('b');

    const [firstResult, secondResult] = await Promise.all([
      player.enqueue(first),
      player.enqueue(second),
    ]);

    expect(firstResult.kind).toBe('started');
    expect(secondResult).toMatchObject({ kind: 'queued', position: 1 });
    expect(transport.played).toHaveLength(1);
    expect(player.current).toBe(first);
  });
});

describe('GuildPlayer - auto-next', () => {
  it('starts the next queued track when one ends naturally', async () => {
    const { player, transport } = createPlayer();
    const first = localTrack('a');
    const second = localTrack('b');
    await player.enqueue(first);
    await player.enqueue(second);

    transport.finishTrack();
    await settle(player);

    expect(player.current).toBe(second);
    expect(player.snapshot().status).toBe('playing');
    expect(transport.played.map((source) => source.input)).toEqual(['a.opus', 'b.opus']);
    expect(player.snapshot().upcoming).toEqual([]);
  });

  it('goes idle when the last track ends', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));

    transport.finishTrack();
    await settle(player);

    expect(player.current).toBeUndefined();
    expect(player.snapshot().status).toBe('idle');
    expect(player.snapshot().upcoming).toEqual([]);
  });

  it('walks the whole queue in order', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.enqueue(localTrack('c'));

    transport.finishTrack();
    await settle(player);
    transport.finishTrack();
    await settle(player);

    expect(transport.played.map((source) => source.input)).toEqual(['a.opus', 'b.opus', 'c.opus']);

    transport.finishTrack();
    await settle(player);
    expect(player.snapshot().status).toBe('idle');
  });

  it('ignores a track end that arrives after the player went idle', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.stop();

    transport.finishTrack();
    await settle(player);

    expect(player.current).toBeUndefined();
    expect(transport.played).toHaveLength(1);
  });
});

describe('GuildPlayer - pause and resume', () => {
  it('pauses and resumes the current track', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));

    expect(player.pause()).toBe('paused');
    expect(player.snapshot().status).toBe('paused');
    expect(player.resume()).toBe('resumed');
    expect(player.snapshot().status).toBe('playing');
    expect(transport.paused).toBe(false);
  });

  it('is idempotent about pausing and resuming', async () => {
    const { player } = createPlayer();
    await player.enqueue(localTrack('a'));

    expect(player.resume()).toBe('already-playing');
    player.pause();
    expect(player.pause()).toBe('already-paused');
  });

  it('reports nothing playing when idle', () => {
    const { player } = createPlayer();

    expect(player.pause()).toBe('nothing-playing');
    expect(player.resume()).toBe('nothing-playing');
  });

  it('keeps the queue untouched', async () => {
    const { player } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));

    player.pause();
    player.resume();

    expect(player.snapshot().upcoming).toHaveLength(1);
  });

  it('stays playing when the transport refuses to pause', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    transport.setPauseSucceeds(false);

    expect(player.pause()).toBe('nothing-playing');
    expect(player.snapshot().status).toBe('playing');
  });
});

describe('GuildPlayer - skip', () => {
  it('skips to the next queued track', async () => {
    const { player, transport } = createPlayer();
    const first = localTrack('a');
    const second = localTrack('b');
    await player.enqueue(first);
    await player.enqueue(second);

    const result = await player.skip();

    expect(result.skipped).toBe(first);
    expect(result.next).toBe(second);
    expect(player.current).toBe(second);
    expect(transport.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('goes idle when skipping the last track', async () => {
    const { player } = createPlayer();
    const only = localTrack('a');
    await player.enqueue(only);

    const result = await player.skip();

    expect(result).toEqual({ skipped: only, next: undefined });
    expect(player.current).toBeUndefined();
    expect(player.snapshot().status).toBe('idle');
  });

  it('reports nothing to skip on an idle player', async () => {
    const { player } = createPlayer();

    expect(await player.skip()).toEqual({ skipped: undefined, next: undefined });
  });

  it('does not double advance when stopping also reports a track end', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.enqueue(localTrack('c'));
    // The Idle transition caused by the skip itself must be ignored.
    transport.emitTrackEndOnStop(true);

    await player.skip();
    await settle(player);

    expect(transport.played.map((source) => source.input)).toEqual(['a.opus', 'b.opus']);
    expect(player.snapshot().upcoming).toHaveLength(1);
    expect(player.current?.sourceId).toBe('b');
  });

  it('skips while paused and plays the next track', async () => {
    const { player } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    player.pause();

    const result = await player.skip();

    expect(result.next?.sourceId).toBe('b');
    expect(player.snapshot().status).toBe('playing');
  });
});

describe('GuildPlayer - stop', () => {
  it('stops the current track and clears the queue', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));

    const stopped = await player.stop();

    expect(stopped).toBe(true);
    expect(player.current).toBeUndefined();
    expect(player.snapshot()).toMatchObject({ status: 'idle', upcoming: [] });
    expect(transport.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('never triggers an auto-next', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.enqueue(localTrack('c'));

    await player.stop();
    transport.finishTrack();
    await settle(player);

    expect(transport.played).toHaveLength(1);
    expect(player.current).toBeUndefined();
  });

  it('never auto-nexts even when stopping emits a track end', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    transport.emitTrackEndOnStop(true);

    await player.stop();
    await settle(player);

    expect(transport.played).toHaveLength(1);
    expect(player.current).toBeUndefined();
    expect(player.snapshot().upcoming).toEqual([]);
  });

  it('reports that there was nothing to stop', async () => {
    const { player } = createPlayer();

    expect(await player.stop()).toBe(false);
  });

  it('leaves the player usable afterwards', async () => {
    const { player } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.stop();

    const result = await player.enqueue(localTrack('b'));

    expect(result.kind).toBe('started');
    expect(player.current?.sourceId).toBe('b');
  });
});

describe('GuildPlayer - playback failures', () => {
  it('reports a track that cannot start and keeps the state coherent', async () => {
    const { player, transport } = createPlayer();
    transport.failFor('a.opus');

    const result = await player.enqueue(localTrack('a'));

    expect(result.kind).toBe('failed');
    expect(player.current).toBeUndefined();
    expect(player.snapshot().status).toBe('idle');
    expect(player.snapshot().upcoming).toEqual([]);
  });

  it('advances to the next track when auto-next hits a broken one', async () => {
    const { player, transport } = createPlayer();
    transport.failFor('b.opus');
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.enqueue(localTrack('c'));

    transport.finishTrack();
    await settle(player);

    expect(player.current?.sourceId).toBe('c');
    expect(transport.played.map((source) => source.input)).toEqual(['a.opus', 'c.opus']);
  });

  it('gives up after too many consecutive failures instead of looping', async () => {
    const { player, transport, logger } = createPlayer();
    const broken = ['b', 'c', 'd', 'e', 'f'];
    transport.failFor(...broken.map((id) => `${id}.opus`));
    await player.enqueue(localTrack('a'));
    for (const id of broken) {
      await player.enqueue(localTrack(id));
    }

    transport.finishTrack();
    await settle(player);

    expect(player.current).toBeUndefined();
    expect(player.snapshot().status).toBe('idle');
    expect(player.snapshot().upcoming.length).toBe(broken.length - MAX_CONSECUTIVE_FAILURES);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('recovers the current track slot when playback breaks mid-track', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));

    transport.breakPlayback();
    await settle(player);

    expect(player.current?.sourceId).toBe('b');
    expect(transport.played.map((source) => source.input)).toEqual(['a.opus', 'b.opus']);
  });

  it('ignores a playback error that arrives when nothing is playing', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.stop();

    transport.breakPlayback();
    await settle(player);

    expect(player.current).toBeUndefined();
    expect(transport.played).toHaveLength(1);
  });
});

describe('GuildPlayer - destroy', () => {
  it('clears everything and stops the transport', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));

    player.destroy();

    expect(player.current).toBeUndefined();
    expect(player.snapshot()).toMatchObject({ status: 'idle', upcoming: [] });
    expect(transport.stopCount).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));

    player.destroy();
    const stopsAfterFirst = transport.stopCount;
    player.destroy();
    player.destroy();

    expect(transport.stopCount).toBe(stopsAfterFirst);
  });

  it('refuses to start anything after destruction', async () => {
    const { player, transport } = createPlayer();
    player.destroy();

    const result = await player.enqueue(localTrack('a'));

    expect(result.kind).toBe('failed');
    expect(transport.played).toEqual([]);
  });

  it('ignores a track end delivered after destruction', async () => {
    const { player, transport } = createPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));

    player.destroy();
    transport.finishTrack();
    await settle(player);

    expect(transport.played).toHaveLength(1);
    expect(player.current).toBeUndefined();
  });
});

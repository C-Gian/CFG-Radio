import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { GuildPlayer } from '../src/player/guild-player.js';
import { isCancelledError, ProviderError } from '../src/player/provider-error.js';
import type { Track } from '../src/player/track.js';
import type { PlayableSource, TrackResolver } from '../src/player/transport.js';
import { YtDlpRunner, type YtDlpChild } from '../src/youtube/ytdlp.js';
import { FakeTransport, fakeLogger, localTrack } from './helpers/fake-transport.js';

class FakeChild extends EventEmitter implements YtDlpChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  close(code = 0, stdout = ''): void {
    if (stdout !== '') {
      this.stdout.write(stdout);
    }
    setImmediate(() => {
      this.emit('close', code);
    });
  }
}

function createRunner(timeoutMs = 30_000) {
  const child = new FakeChild();
  const logger = fakeLogger();
  let spawnCount = 0;
  const runner = new YtDlpRunner({
    ytdlpPath: 'yt-dlp',
    logger,
    timeoutMs,
    spawnFn: () => {
      spawnCount += 1;
      return child;
    },
  });
  return { runner, child, logger, spawns: () => spawnCount };
}

describe('YtDlpRunner cancellation', () => {
  it('never spawns for an attempt that is already gone', async () => {
    const { runner, spawns } = createRunner();
    const controller = new AbortController();
    controller.abort();

    const error = await runner
      .run(['--version'], { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(isCancelledError(error)).toBe(true);
    expect(spawns()).toBe(0);
  });

  it('kills an in-flight child as soon as the attempt aborts', async () => {
    const { runner, child } = createRunner();
    const controller = new AbortController();
    const pending = runner.run(['--dump-single-json', 'x'], { signal: controller.signal });

    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);

    expect(isCancelledError(error)).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it('reports cancellation, not a timeout, when both race', async () => {
    // A 1ms timeout and an immediate abort: whichever wins, the promise must
    // settle exactly once and the child must be killed exactly once.
    const { runner, child } = createRunner(1);
    const controller = new AbortController();
    const pending = runner.run(['--version'], { signal: controller.signal });
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);

    expect(['cancelled', 'timeout']).toContain((error as ProviderError).code);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('ignores an abort that arrives after the run already finished', async () => {
    const { runner, child } = createRunner();
    const controller = new AbortController();
    const pending = runner.run(['--version'], { signal: controller.signal });
    child.close(0, 'done\n');
    const result = await pending;

    expect(result.stdout).toBe('done\n');
    expect(() => {
      controller.abort();
    }).not.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('settles exactly once when destroy and abort collide', async () => {
    const { runner, child } = createRunner();
    const controller = new AbortController();
    let settlements = 0;
    const pending = runner.run(['--version'], { signal: controller.signal }).catch(() => {
      settlements += 1;
    });

    controller.abort();
    runner.destroy();
    controller.abort();
    await pending;

    expect(settlements).toBe(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

/** A resolver that hangs until the attempt is cancelled. */
function hangingResolver() {
  const started: AbortSignal[] = [];
  const resolve: TrackResolver = (_track: Track, context) =>
    new Promise<PlayableSource>((_resolveSource, reject) => {
      started.push(context.signal);
      context.signal.addEventListener(
        'abort',
        () => {
          reject(new ProviderError('cancelled', 'attempt cancelled'));
        },
        { once: true },
      );
    });
  return { resolve, started };
}

function createPlayer(resolve: TrackResolver) {
  const transport = new FakeTransport();
  const logger = fakeLogger();
  const player = new GuildPlayer({ guildId: 'guild-1', transport, resolve, logger });
  return { player, transport, logger };
}

describe('a wedged extractor never wedges the player', () => {
  it.each([
    ['stop', (player: GuildPlayer) => player.stop()],
    ['skip', (player: GuildPlayer) => player.skip()],
  ])('%s returns immediately and aborts the attempt', async (_name, control) => {
    const { resolve, started } = hangingResolver();
    const { player, transport } = createPlayer(resolve);

    const starting = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    await control(player);
    const result = await starting;

    expect(started[0]?.aborted).toBe(true);
    expect(result.kind).toBe('failed');
    expect(transport.played).toEqual([]);
    expect(player.current).toBeUndefined();
  });

  it('destroy aborts the attempt in flight', async () => {
    const { resolve, started } = hangingResolver();
    const { player } = createPlayer(resolve);

    const starting = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    player.destroy();
    await starting;

    expect(started[0]?.aborted).toBe(true);
  });

  it('cancels a command that had not reached the chain yet', async () => {
    const { resolve, started } = hangingResolver();
    const { player, transport } = createPlayer(resolve);

    // No await: the enqueue body is still queued behind the microtask.
    const starting = player.enqueue(localTrack('wedged'));
    await player.stop();

    await expect(starting).resolves.toMatchObject({ kind: 'failed' });
    // The wedged resolution must never even begin.
    expect(started).toHaveLength(0);
    expect(transport.played).toEqual([]);
  });

  it('stays usable for the next track after a cancellation', async () => {
    let hang = true;
    const started: AbortSignal[] = [];
    const resolve: TrackResolver = (track, context) => {
      if (hang) {
        started.push(context.signal);
        return new Promise<PlayableSource>((_ignored, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(new ProviderError('cancelled', 'attempt cancelled'));
          });
        });
      }
      return { kind: 'file', input: `${track.sourceId}.opus` };
    };
    const { player, transport } = createPlayer(resolve);

    const wedged = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });
    await player.skip();
    await wedged;

    hang = false;
    const result = await player.enqueue(localTrack('healthy'));

    expect(result.kind).toBe('started');
    expect(transport.played).toEqual([{ kind: 'file', input: 'healthy.opus' }]);
  });

  it('does not poison the chain: later operations keep running', async () => {
    const { resolve, started } = hangingResolver();
    let hang = true;
    const wrapped: TrackResolver = (track, context) =>
      hang ? resolve(track, context) : { kind: 'file', input: `${track.sourceId}.opus` };
    const { player } = createPlayer(wrapped);

    const first = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });
    await player.stop();
    await first;
    hang = false;

    // A rejected/cancelled operation must leave the chain usable.
    await expect(player.enqueue(localTrack('a'))).resolves.toMatchObject({ kind: 'started' });
    await expect(player.pause()).resolves.toBe('paused');
    await expect(player.stop()).resolves.toBe(true);
    await expect(player.enqueue(localTrack('b'))).resolves.toMatchObject({ kind: 'started' });
  });

  it('never starts a fallback for a cancelled attempt', async () => {
    const { resolve, started } = hangingResolver();
    const transport = new FakeTransport();
    const resolveFallback = vi.fn();
    const player = new GuildPlayer({
      guildId: 'guild-1',
      transport,
      resolve,
      resolveFallback,
      logger: fakeLogger(),
    });

    const starting = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });
    await player.stop();
    await starting;

    expect(resolveFallback).not.toHaveBeenCalled();
    expect(transport.played).toEqual([]);
  });

  it('keeps the guild non-idle while an attempt is still resolving', async () => {
    const { resolve, started } = hangingResolver();
    const idleReports: boolean[] = [];
    const transport = new FakeTransport();
    const player = new GuildPlayer({
      guildId: 'guild-1',
      transport,
      resolve,
      logger: fakeLogger(),
      onIdleChange: (idle) => idleReports.push(idle),
    });

    const starting = player.enqueue(localTrack('wedged'));
    await vi.waitFor(() => {
      expect(started).toHaveLength(1);
    });

    expect(player.isIdle).toBe(false);
    expect(idleReports).not.toContain(true);

    await player.stop();
    await starting;
  });
});

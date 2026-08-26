import 'dotenv/config';

import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createLogger } from './logger.js';
import { GuildPlayer } from './player/guild-player.js';
import { isCancelledError, isProviderError } from './player/provider-error.js';
import { createTrack, type Track } from './player/track.js';
import type { PlayableSource, PlaybackTransport } from './player/transport.js';
import { MAX_YTDLP_OUTPUT_BYTES, YtDlpRunner } from './youtube/ytdlp.js';

/**
 * Ops-only stress check for cancellation, process lifecycle and isolation.
 *
 * Everything here is local: a small Node helper stands in for yt-dlp, so the
 * result never depends on YouTube, SoundCloud or the network. Run it with
 * `npm run diagnostics:hardening`.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_EXTRACTOR = resolve(packageRoot, 'tools', 'fake-extractor.mjs');
const SOAK_CYCLES = Number(process.env.HARDENING_SOAK_CYCLES ?? 200);

const logger = createLogger('error');
const failures: string[] = [];
const execFileAsync = promisify(execFile);

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`);
  if (!ok) {
    failures.push(name);
  }
}

/** Node children of this process, counted without any shell. */
async function childProcessCount(): Promise<number> {
  const pid = process.pid;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('wmic', [
        'process',
        'where',
        `ParentProcessId=${pid}`,
        'get',
        'ProcessId',
      ]);
      return stdout.split('\n').filter((line) => /\d/.test(line)).length;
    }
    const { stdout } = await execFileAsync('ps', ['--no-headers', '-o', 'pid', '--ppid', `${pid}`]);
    return stdout.split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return -1;
  }
}

function extractorRunner(timeoutMs: number): YtDlpRunner {
  return new YtDlpRunner({ ytdlpPath: process.execPath, logger, timeoutMs });
}

const hangArgs = [FAKE_EXTRACTOR, 'hang'];

async function checkTimeoutKills(): Promise<void> {
  console.log('=== Timeout terminates a wedged extractor ===');
  const runner = extractorRunner(700);
  const started = performance.now();
  const error = await runner.run(hangArgs).catch((caught: unknown) => caught);
  const elapsed = performance.now() - started;

  check('timeout classified', isProviderError(error) && error.code === 'timeout');
  check('timeout is prompt', elapsed < 3_000, `${elapsed.toFixed(0)}ms`);
  runner.destroy();
}

async function checkAbortBeatsTimeout(): Promise<void> {
  console.log('=== AbortSignal terminates it before the timeout ===');
  const runner = extractorRunner(30_000);
  const controller = new AbortController();
  const started = performance.now();
  const pending = runner.run(hangArgs, { signal: controller.signal });

  setTimeout(() => {
    controller.abort();
  }, 150);
  const error = await pending.catch((caught: unknown) => caught);
  const elapsed = performance.now() - started;

  check('cancellation classified', isCancelledError(error));
  check('abort does not wait for the 30s timeout', elapsed < 3_000, `${elapsed.toFixed(0)}ms`);

  // Repeated aborts must stay harmless.
  controller.abort();
  controller.abort();
  check('repeated abort is idempotent', true);
  runner.destroy();
}

async function checkPreAbortedNeverSpawns(): Promise<void> {
  console.log('=== A dead attempt spawns nothing ===');
  let spawned = 0;
  const runner = new YtDlpRunner({
    ytdlpPath: process.execPath,
    logger,
    spawnFn: () => {
      spawned += 1;
      throw new Error('should never be reached');
    },
  });
  const controller = new AbortController();
  controller.abort();

  const error = await runner.run(hangArgs, { signal: controller.signal }).catch((c: unknown) => c);
  check('pre-aborted run is cancelled', isCancelledError(error));
  check('no child was spawned', spawned === 0);
  runner.destroy();
}

async function checkOutputCap(): Promise<void> {
  console.log('=== Output cap terminates a flooding extractor ===');
  const runner = extractorRunner(20_000);
  const before = process.memoryUsage().heapUsed;
  const error = await runner
    .run([FAKE_EXTRACTOR, 'flood', String(MAX_YTDLP_OUTPUT_BYTES)])
    .catch((caught: unknown) => caught);
  const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

  check(
    'flood classified as extractor_failed',
    isProviderError(error) && error.code === 'extractor_failed',
  );
  check('heap growth stays bounded', growthMb < 200, `${growthMb.toFixed(0)}MB`);
  runner.destroy();
}

async function checkDestroyAborts(): Promise<void> {
  console.log('=== Shutdown aborts everything in flight ===');
  const runner = extractorRunner(30_000);
  const first = runner.run(hangArgs).catch((error: unknown) => error);
  const second = runner.run(hangArgs).catch((error: unknown) => error);
  await new Promise((done) => setTimeout(done, 200));

  const started = performance.now();
  runner.destroy();
  const [a, b] = await Promise.all([first, second]);
  const elapsed = performance.now() - started;

  check('every active run is cancelled', isCancelledError(a) && isCancelledError(b));
  check('shutdown does not wait for timeouts', elapsed < 2_000, `${elapsed.toFixed(0)}ms`);
  const later = await runner.run(hangArgs).catch((error: unknown) => error);
  check('a destroyed runner refuses new work', isProviderError(later));
}

/** Transport that never really plays anything, but records what it was asked. */
class RecordingTransport implements PlaybackTransport {
  played = 0;
  stops = 0;
  private endListener: (() => void) | undefined;

  play(): Promise<void> {
    this.played += 1;
    return Promise.resolve();
  }
  pause(): boolean {
    return true;
  }
  resume(): boolean {
    return true;
  }
  setVolume(): void {
    /* no gain stage in the harness */
  }
  stopPlayback(): void {
    this.stops += 1;
  }
  onTrackEnd(listener: () => void): void {
    this.endListener = listener;
  }
  onPlaybackError(): void {
    /* the harness drives failures through the resolver */
  }
  finish(): void {
    this.endListener?.();
  }
}

const SOAK_PATIENCE_MS = 50;

/**
 * Awaits a player operation, breaking a wedged attempt with /skip.
 *
 * A hanging resolution owns the serialisation chain until something cancels
 * it, which is precisely the behaviour under test.
 */
async function awaitOrSkip(player: GuildPlayer, operation: Promise<unknown>): Promise<void> {
  const settled = operation.then(
    () => 'settled',
    () => 'settled',
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const outcome = await Promise.race([
      settled,
      new Promise<string>((done) =>
        setTimeout(() => {
          done('pending');
        }, SOAK_PATIENCE_MS),
      ),
    ]);
    if (outcome === 'settled') {
      return;
    }
    // Fired, never awaited: pressing /skip aborts the active attempt
    // synchronously, but its own answer may queue behind another wedged one -
    // which is exactly what a user pressing the button again would do.
    void player.skip().catch(() => undefined);
  }
  await settled;
}

function soakTrack(index: number): Track {
  return createTrack({
    title: `Soak ${index}`,
    source: 'local',
    sourceId: `soak-${index}`,
    originalInput: `soak-${index}`,
    requestedByUserId: 'diagnostic',
    durationMs: 1_000,
  });
}

async function checkSoak(): Promise<void> {
  console.log(`=== Soak: ${SOAK_CYCLES} play/skip/stop/failure cycles ===`);
  const transport = new RecordingTransport();
  const pendingResolutions = new Set<() => void>();
  let rejections = 0;
  const onRejection = (): void => {
    rejections += 1;
  };
  process.on('unhandledRejection', onRejection);

  const player = new GuildPlayer({
    guildId: 'soak-guild',
    transport,
    resolve: (track, context) => {
      // Every fourth track hangs until it is cancelled; every fifth fails.
      if (track.sourceId.endsWith('3')) {
        return new Promise<PlayableSource>((_resolve, reject) => {
          const cancel = (): void => {
            pendingResolutions.delete(cancel);
            reject(new Error('cancelled by the attempt'));
          };
          pendingResolutions.add(cancel);
          context.signal.addEventListener('abort', cancel, { once: true });
        });
      }
      if (track.sourceId.endsWith('7')) {
        return Promise.reject(new Error('simulated resolution failure'));
      }
      return { kind: 'file', input: `${track.sourceId}.opus` };
    },
    logger,
  });

  const before = process.memoryUsage().heapUsed;
  for (let cycle = 0; cycle < SOAK_CYCLES; cycle += 1) {
    // Fired, not awaited: a wedged resolution blocks the whole chain, and
    // breaking that with a control operation is exactly what M8 promises.
    const starting = player.enqueue(soakTrack(cycle));
    await awaitOrSkip(player, starting);

    await awaitOrSkip(
      player,
      player.enqueueMany([soakTrack(cycle * 10 + 1), soakTrack(cycle * 10 + 2)]),
    );
    if (cycle % 3 === 0) {
      // A skip can itself start a wedged track, so it gets the same treatment.
      await awaitOrSkip(player, player.skip());
    }
    if (cycle % 5 === 0) {
      transport.finish();
      await awaitOrSkip(player, player.whenSettled());
    }
    if (cycle % 7 === 0) {
      await player.stop();
    }
  }
  await player.stop();
  await player.whenSettled();
  player.destroy();
  await player.whenSettled();
  await new Promise((done) => setImmediate(done));
  process.off('unhandledRejection', onRejection);

  const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  const snapshot = player.snapshot();
  check('queue is empty at the end', snapshot.upcoming.length === 0);
  check('nothing is current at the end', snapshot.current === undefined);
  check('no hanging resolution survived', pendingResolutions.size === 0);
  check('no unhandled rejection', rejections === 0, `${rejections}`);
  check('heap growth is reasonable', growthMb < 100, `${growthMb.toFixed(1)}MB`);
  console.log(`  info: ${transport.played} starts, ${transport.stops} stops`);
}

async function checkSerializeSurvivesFailure(): Promise<void> {
  console.log('=== A rejected operation does not poison the chain ===');
  const transport = new RecordingTransport();
  let failNext = true;
  const player = new GuildPlayer({
    guildId: 'chain-guild',
    transport,
    resolve: (track) => {
      if (failNext) {
        failNext = false;
        throw new Error('first operation explodes');
      }
      return { kind: 'file', input: `${track.sourceId}.opus` };
    },
    logger,
  });

  const first = await player.enqueue(soakTrack(1));
  await player.stop();
  const second = await player.enqueue(soakTrack(2));

  check('first operation failed', first.kind === 'failed');
  check('later operations still run', second.kind === 'started');
  player.destroy();
}

async function main(): Promise<void> {
  const childrenBefore = await childProcessCount();

  await checkTimeoutKills();
  await checkAbortBeatsTimeout();
  await checkPreAbortedNeverSpawns();
  await checkOutputCap();
  await checkDestroyAborts();
  await checkSerializeSurvivesFailure();
  await checkSoak();

  console.log('=== Process hygiene ===');
  // Killed children need a moment to be reaped by the OS.
  await new Promise((done) => setTimeout(done, 1_000));
  const childrenAfter = await childProcessCount();
  if (childrenBefore < 0 || childrenAfter < 0) {
    console.log('  skip child process count (no supported inspector on this platform)');
  } else {
    check('no child process left behind', childrenAfter <= childrenBefore, `${childrenAfter}`);
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`Hardening diagnostics FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Hardening diagnostics OK.');
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Hardening diagnostics crashed', error);
  process.exit(1);
}

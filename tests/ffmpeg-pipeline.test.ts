import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { FfmpegPipeline, buildFfmpegArgs, type FfmpegChild } from '../src/audio/ffmpeg.js';

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

class FakeChild extends EventEmitter implements FfmpegChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);
}

function startPipeline(
  overrides: { child?: FakeChild; onUnexpectedExit?: (reason: string) => void } = {},
) {
  const child = overrides.child ?? new FakeChild();
  const logger = fakeLogger();
  const pipeline = FfmpegPipeline.start({
    ffmpegPath: 'ffmpeg',
    inputPath: 'C:/tmp/tone.opus',
    logger,
    spawnFn: () => child,
    ...(overrides.onUnexpectedExit ? { onUnexpectedExit: overrides.onUnexpectedExit } : {}),
  });
  return { pipeline, child, logger };
}

describe('buildFfmpegArgs', () => {
  const args = buildFfmpegArgs('C:/music/song.opus');

  it('reads the requested input and writes Ogg/Opus to stdout', () => {
    expect(args).toContain('C:/music/song.opus');
    expect(args.slice(-3)).toEqual(['-f', 'opus', 'pipe:1']);
  });

  it('encodes with libopus at 48 kHz stereo and drops video', () => {
    expect(args).toContain('libopus');
    expect(args.slice(args.indexOf('-ar') + 1, args.indexOf('-ar') + 2)).toEqual(['48000']);
    expect(args.slice(args.indexOf('-ac') + 1, args.indexOf('-ac') + 2)).toEqual(['2']);
    expect(args).toContain('-vn');
  });

  it('stays quiet and never waits on stdin', () => {
    expect(args).toContain('-nostdin');
    expect(args).toContain('-hide_banner');
    expect(args.slice(args.indexOf('-loglevel') + 1, args.indexOf('-loglevel') + 2)).toEqual([
      'warning',
    ]);
  });
});

describe('FfmpegPipeline', () => {
  it('reports a synchronous spawn failure as an error', () => {
    expect(() =>
      FfmpegPipeline.start({
        ffmpegPath: 'nope',
        inputPath: 'in.opus',
        logger: fakeLogger(),
        spawnFn: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/Failed to spawn FFmpeg/);
  });

  it('exposes stdout as the audio stream', async () => {
    const { pipeline, child } = startPipeline();
    const received = new Promise<string>((resolve) => {
      pipeline.output.once('data', (chunk: Buffer) => {
        resolve(chunk.toString());
      });
    });

    child.stdout.write('OggS');

    await expect(received).resolves.toBe('OggS');
  });

  it('kills the process on stop and destroys the pipes', () => {
    const { pipeline, child } = startPipeline();

    pipeline.stop();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(pipeline.isRunning).toBe(false);
  });

  it('is idempotent: stopping twice kills the process once', () => {
    const { pipeline, child } = startPipeline();

    pipeline.stop();
    pipeline.stop();
    pipeline.stop();

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('does not kill a process that already exited', () => {
    const { pipeline, child } = startPipeline();

    child.emit('close', 0, null);
    pipeline.stop();

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('reports an abnormal exit instead of throwing', () => {
    const onUnexpectedExit = vi.fn();
    const { child } = startPipeline({ onUnexpectedExit });

    child.emit('close', 1, null);

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(String(onUnexpectedExit.mock.calls[0]?.[0])).toContain('code 1');
  });

  it('reports a spawn error emitted asynchronously', () => {
    const onUnexpectedExit = vi.fn();
    const { child, logger } = startPipeline({ onUnexpectedExit });

    child.emit('error', new Error('spawn ENOENT'));

    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('stays silent about an exit that follows an explicit stop', () => {
    const onUnexpectedExit = vi.fn();
    const { pipeline, child } = startPipeline({ onUnexpectedExit });

    pipeline.stop();
    child.emit('close', null, 'SIGKILL');

    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('logs FFmpeg stderr as warnings', async () => {
    const { child, logger } = startPipeline();

    child.stderr.write('Invalid data found when processing input\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('Invalid data');
  });

  it('swallows stdout errors so a closed pipe cannot crash the bot', () => {
    const { child, logger } = startPipeline();

    expect(() => child.stdout.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(logger.debug).toHaveBeenCalled();
  });
});

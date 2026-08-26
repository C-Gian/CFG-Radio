import { describe, expect, it, vi } from 'vitest';

import { FfmpegPipeline, collectPipelineOutput, probeFfmpeg } from '../src/audio/ffmpeg.js';
import { TEST_TONE_PATH, assertTestToneExists } from '../src/audio/test-tone.js';
import { ffmpegPathFromEnv } from '../src/config/env.js';

/**
 * Local integration test: runs the real playback pipeline over the synthetic
 * asset. No Discord, no network - just FFmpeg and a file on disk.
 *
 * Skipped (instead of failing) when the machine has no usable FFmpeg, so the
 * unit suite stays runnable anywhere.
 */
const ffmpegPath = ffmpegPathFromEnv();
const probe = await probeFfmpeg(ffmpegPath);
const usable = probe.available && probe.hasLibopus;

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

describe('test tone asset', () => {
  it('lives in assets/ and is readable', async () => {
    expect(TEST_TONE_PATH.replaceAll('\\', '/')).toMatch(/\/assets\/test-tone\.opus$/);
    await expect(assertTestToneExists()).resolves.toBeUndefined();
  });

  it('explains how to recover when the asset is missing', async () => {
    await expect(assertTestToneExists('does-not-exist.opus')).rejects.toThrow(
      /npm run assets:tone/,
    );
  });
});

describe.skipIf(!usable)('FFmpeg pipeline (real process)', () => {
  it('has a libopus enabled build available', () => {
    expect(probe.hasLibopus).toBe(true);
    expect(probe.version).toContain('ffmpeg version');
  });

  it('transcodes the test tone into a streamable Ogg/Opus output', async () => {
    const logger = fakeLogger();
    const pipeline = FfmpegPipeline.start({ ffmpegPath, inputPath: TEST_TONE_PATH, logger });

    const output = await collectPipelineOutput(pipeline);
    pipeline.stop();

    expect(output.byteLength).toBeGreaterThan(10_000);
    expect(output.subarray(0, 4).toString('ascii')).toBe('OggS');
    expect(logger.error).not.toHaveBeenCalled();
    expect(pipeline.isRunning).toBe(false);
  }, 30_000);

  it('reports a bad input without crashing, and cleans up', async () => {
    const logger = fakeLogger();
    const reasons: string[] = [];
    const pipeline = FfmpegPipeline.start({
      ffmpegPath,
      inputPath: 'this-file-does-not-exist.opus',
      logger,
      onUnexpectedExit: (reason) => reasons.push(reason),
    });

    await collectPipelineOutput(pipeline);
    // Give FFmpeg's exit event a chance to land after stdout closed.
    await vi.waitFor(() => {
      expect(reasons).toHaveLength(1);
    });

    pipeline.stop();
    expect(reasons[0]).toMatch(/exited with code/);
    expect(pipeline.isRunning).toBe(false);
  }, 30_000);
});

import { describe, expect, it, vi } from 'vitest';

import { FfmpegPipeline, collectPipelineOutput, probeFfmpeg } from '../src/audio/ffmpeg.js';
import {
  LOCAL_ASSETS,
  assertAssetExists,
  localAssetPath,
  resolveLocalTrack,
} from '../src/audio/local-catalog.js';
import { ffmpegPathFromEnv } from '../src/config/env.js';
import { createTrack } from '../src/player/track.js';

/**
 * Local integration test: runs the real playback pipeline over every synthetic
 * asset. No Discord, no network - just FFmpeg and files on disk.
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

describe('local assets on disk', () => {
  it.each(LOCAL_ASSETS.map((asset) => [asset.id, asset] as const))(
    '%s is readable',
    async (_id, asset) => {
      await expect(assertAssetExists(localAssetPath(asset))).resolves.toBeUndefined();
    },
  );

  it('explains how to recover when an asset is missing', async () => {
    await expect(assertAssetExists('does-not-exist.opus')).rejects.toThrow(
      /npm run assets:generate/,
    );
  });

  it('resolves a track to a file that really exists', async () => {
    const track = createTrack({
      title: 'Arpeggio',
      source: 'local',
      sourceId: 'arpeggio',
      originalInput: 'arpeggio',
      requestedByUserId: 'user-1',
    });

    const source = await resolveLocalTrack(track);

    await expect(assertAssetExists(source.input)).resolves.toBeUndefined();
  });
});

describe.skipIf(!usable)('FFmpeg pipeline (real process)', () => {
  it('has a libopus enabled build available', () => {
    expect(probe.hasLibopus).toBe(true);
    expect(probe.version).toContain('ffmpeg version');
  });

  it.each(LOCAL_ASSETS.map((asset) => [asset.id, asset] as const))(
    'transcodes %s into a streamable Ogg/Opus output',
    async (_id, asset) => {
      const logger = fakeLogger();
      const pipeline = FfmpegPipeline.start({
        ffmpegPath,
        inputPath: localAssetPath(asset),
        logger,
      });

      const output = await collectPipelineOutput(pipeline);
      pipeline.stop();

      expect(output.byteLength).toBeGreaterThan(10_000);
      expect(output.subarray(0, 4).toString('ascii')).toBe('OggS');
      expect(logger.error).not.toHaveBeenCalled();
      expect(pipeline.isRunning).toBe(false);
    },
    30_000,
  );

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

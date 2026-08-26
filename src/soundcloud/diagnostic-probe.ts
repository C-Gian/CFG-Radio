import { FfmpegPipeline } from '../audio/ffmpeg.js';
import type { PlayableSource } from '../player/transport.js';
import type { Logger } from '../logger.js';

export const SOUNDCLOUD_DIAGNOSTIC_QUERY = 'Scott Buckley Signal To Noise';
export const SOUNDCLOUD_DIAGNOSTIC_TRACK = {
  title: 'Scott Buckley - Signal To Noise',
  artist: 'Scott Buckley',
  durationMs: 353_545,
} as const;

/** Reads enough of a real remote source to prove FFmpeg can decode it. */
export async function probeSoundCloudWithFfmpeg(
  source: PlayableSource,
  ffmpegPath: string,
  logger: Logger,
): Promise<number> {
  const pipeline = FfmpegPipeline.start({
    ffmpegPath,
    inputPath: source.input,
    inputOptions: { headers: source.headers, remote: true },
    logger,
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      let total = 0;
      let settled = false;
      const finish = (result: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result();
      };
      const timer = setTimeout(() => {
        finish(() => {
          reject(new Error('FFmpeg did not produce SoundCloud audio within 20s'));
        });
      }, 20_000);
      timer.unref();

      pipeline.output.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > 30_000) {
          finish(() => {
            resolve(total);
          });
        }
      });
      pipeline.output.on('end', () => {
        finish(() => {
          resolve(total);
        });
      });
      pipeline.output.on('error', (error) => {
        finish(() => {
          reject(error);
        });
      });
    });
  } finally {
    pipeline.stop();
  }
}

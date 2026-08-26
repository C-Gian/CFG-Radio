import { describe, expect, it } from 'vitest';

import { FfmpegPipeline, probeFfmpeg } from '../../src/audio/ffmpeg.js';
import { createTrackResolver } from '../../src/audio/track-resolver.js';
import { ffmpegPathFromEnv, ytdlpPathFromEnv } from '../../src/config/env.js';
import { isProviderError } from '../../src/player/provider-error.js';
import { createTrack } from '../../src/player/track.js';
import { fetchYouTubeMetadata, toYouTubeTrack } from '../../src/youtube/metadata.js';
import { classifyInput } from '../../src/youtube/url.js';
import { YtDlpRunner } from '../../src/youtube/ytdlp.js';
import { fakeLogger } from '../helpers/fake-transport.js';

/**
 * Real yt-dlp + real YouTube + real FFmpeg.
 *
 * Deliberately excluded from `npm test`: an upstream outage, a rate limit or a
 * missing yt-dlp must never turn the normal suite red. Run it on demand with
 * `npm run test:integration`.
 *
 * The video below is public, ancient and tiny ("Me at the zoo", 19s) - it needs
 * no account, no cookie and no region.
 */
const VIDEO_URL = process.env.YOUTUBE_TEST_URL ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const ytdlpPath = ytdlpPathFromEnv();
const ffmpegPath = ffmpegPathFromEnv();
const logger = fakeLogger();
const runner = new YtDlpRunner({ ytdlpPath, logger, timeoutMs: 60_000 });

describe('yt-dlp is usable', () => {
  it('reports a version', async () => {
    const version = await runner.version();

    expect(version).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
  });

  it('classifies a bogus input instead of throwing something raw', async () => {
    const error = await runner
      .json(['--dump-json', 'not-a-url'])
      .catch((caught: unknown) => caught);

    expect(isProviderError(error)).toBe(true);
  });
});

describe('YouTube metadata (live)', () => {
  it('resolves the metadata of a public video', async () => {
    const classified = classifyInput(VIDEO_URL);
    expect(classified.kind).toBe('youtube-video');
    if (classified.kind !== 'youtube-video') {
      return;
    }

    const metadata = await fetchYouTubeMetadata(
      runner,
      classified.canonicalUrl,
      classified.videoId,
    );

    expect(metadata.videoId).toBe(classified.videoId);
    expect(metadata.title.length).toBeGreaterThan(0);
    expect(metadata.canonicalUrl).toContain(classified.videoId);
    expect(metadata.durationMs ?? 0).toBeGreaterThan(0);

    const track = toYouTubeTrack({
      metadata,
      requestedByUserId: 'integration-test',
      originalInput: VIDEO_URL,
    });
    expect(JSON.stringify(track)).not.toContain('googlevideo');
  });
});

describe('YouTube playback resolution (live)', () => {
  it('resolves a direct media URL and streams it through FFmpeg', async () => {
    const classified = classifyInput(VIDEO_URL);
    if (classified.kind !== 'youtube-video') {
      throw new Error('the configured test URL is not a YouTube video');
    }

    const resolve = createTrackResolver({ ytdlp: runner });
    const track = createTrack({
      title: 'integration',
      source: 'youtube',
      sourceId: classified.videoId,
      originalInput: VIDEO_URL,
      requestedByUserId: 'integration-test',
      canonicalUrl: classified.canonicalUrl,
    });

    const source = await resolve(track);
    expect(source.kind).toBe('url');
    expect(source.input).toMatch(/^https:\/\//);

    const probe = await probeFfmpeg(ffmpegPath);
    expect(probe.available).toBe(true);

    // Stream a couple of seconds: enough to prove FFmpeg accepts the URL (and
    // the headers) and produces the Ogg/Opus Discord expects.
    const pipeline = FfmpegPipeline.start({
      ffmpegPath,
      inputPath: source.input,
      inputOptions: { headers: source.headers, remote: true },
      logger,
    });

    const bytes = await new Promise<number>((resolveBytes, reject) => {
      let total = 0;
      let head = Buffer.alloc(0);
      pipeline.output.on('data', (chunk: Buffer) => {
        total += chunk.byteLength;
        if (head.byteLength < 4) {
          head = Buffer.concat([head, chunk]);
        }
        if (total > 30_000) {
          expect(head.subarray(0, 4).toString('ascii')).toBe('OggS');
          pipeline.stop();
          resolveBytes(total);
        }
      });
      pipeline.output.on('end', () => {
        resolveBytes(total);
      });
      pipeline.output.on('error', reject);
    });

    pipeline.stop();
    expect(bytes).toBeGreaterThan(10_000);
  });
});

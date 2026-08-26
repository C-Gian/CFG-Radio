import 'dotenv/config';

import { execFile } from 'node:child_process';
import { access, constants, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { FfmpegPipeline, probeFfmpeg } from './audio/ffmpeg.js';
import { ffmpegPathFromEnv, ytdlpPathFromEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { isProviderError } from './player/provider-error.js';
import { createTrack } from './player/track.js';
import { searchSoundCloudCandidates } from './soundcloud/candidate.js';
import { ensureYtDlp, parseYtDlpVersion } from './setup/ytdlp-bootstrap.js';
import {
  UnsupportedArchitectureError,
  YTDLP_VERSION,
  packageRootDir,
} from './setup/ytdlp-release.js';
import { fetchYouTubeMetadata } from './youtube/metadata.js';
import { resolveYouTubePlayback } from './youtube/playback.js';
import { JS_RUNTIME_ARGS, YtDlpRunner } from './youtube/ytdlp.js';

/**
 * Host readiness check for the managed container deployment.
 *
 * Unlike the other diagnostics this one is allowed to use the network on
 * purpose: the whole point is to prove that *this* machine can really extract
 * from YouTube - including the JavaScript runtime yt-dlp needs for the EJS
 * challenges - and hand the result to the FFmpeg build the image ships.
 *
 * No media is ever downloaded in full and no secret is printed.
 */
const YOUTUBE_PROBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const YOUTUBE_PROBE_ID = 'jNQXAC9IVRw';
const REQUIRED_NODE_MAJOR = 24;

const execFileAsync = promisify(execFile);
const logger = createLogger('error');
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): boolean {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail === '' ? '' : `: ${detail}`}`);
  if (!ok) {
    failures.push(name);
  }
  return ok;
}

async function main(): Promise<void> {
  console.log('=== CFG Radio host diagnostics ===\n');

  console.log('Platform');
  const linux = process.platform === 'linux';
  if (!linux) {
    console.log(
      `  note  this diagnostic targets the Linux container host; ` +
        `running on ${process.platform} only checks what is portable`,
    );
  }
  check(`platform ${process.platform}/${process.arch}`, true);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(
    `Node ${process.versions.node}`,
    Number.isFinite(nodeMajor) && nodeMajor >= REQUIRED_NODE_MAJOR,
    `needs >= ${REQUIRED_NODE_MAJOR}`,
  );

  console.log('\nFFmpeg');
  const ffmpegPath = ffmpegPathFromEnv();
  const ffmpeg = await probeFfmpeg(ffmpegPath);
  check(`executable "${ffmpegPath}"`, ffmpeg.available, ffmpeg.version || (ffmpeg.error ?? ''));
  check('libopus encoder', ffmpeg.hasLibopus);

  console.log('\nFilesystem');
  const probeFile = join(packageRootDir(), '.cfg-radio-write-probe');
  let writable: boolean;
  try {
    await writeFile(probeFile, 'ok');
    await rm(probeFile, { force: true });
    writable = true;
  } catch {
    writable = false;
  }
  check('working directory is writable', writable, packageRootDir());

  console.log('\nyt-dlp');
  let ytdlpPath = ytdlpPathFromEnv();
  try {
    const installed = await ensureYtDlp({ logger });
    ytdlpPath = installed.path;
    check(`pinned binary ${YTDLP_VERSION}`, true, installed.action);
  } catch (error) {
    // The bootstrap only ships Linux builds. On the deployment host that is a
    // hard failure; on a developer machine it is expected, and the yt-dlp that
    // is already installed is checked instead.
    const message = error instanceof Error ? error.message : '';
    if (linux || !(error instanceof UnsupportedArchitectureError)) {
      check(`pinned binary ${YTDLP_VERSION}`, false, message);
    } else {
      console.log(
        `  note  no pinned build for ${process.platform}; checking "${ytdlpPath}" instead`,
      );
    }
  }

  let ytdlpUsable = false;
  try {
    await access(ytdlpPath, constants.X_OK).catch(() => undefined);
    const { stdout } = await execFileAsync(ytdlpPath, ['--version'], {
      timeout: 60_000,
      windowsHide: true,
    });
    const reported = parseYtDlpVersion(stdout);
    ytdlpUsable = check(
      `executes and reports ${YTDLP_VERSION}`,
      reported === YTDLP_VERSION,
      reported ?? 'unknown',
    );
  } catch (error) {
    check('executes', false, error instanceof Error ? error.message : '');
  }

  const runner = new YtDlpRunner({ ytdlpPath, logger, timeoutMs: 90_000 });
  try {
    if (ytdlpUsable) {
      console.log('\nJavaScript runtime for the extractor');
      // yt-dlp reports the runtimes it resolved in its verbose debug block.
      const probeOutput = await runner
        .run([...JS_RUNTIME_ARGS, '--verbose', '--simulate', 'cfg-radio-runtime-probe'])
        .then((result) => result.stderr)
        .catch((error: unknown) => (isProviderError(error) ? (error.diagnostic ?? '') : ''));
      const resolved = /^\[debug\] JS runtimes: (.+)$/m.exec(probeOutput)?.[1]?.trim() ?? '';
      check(
        'yt-dlp resolves the Node runtime',
        /(^|[\s,])node-/.test(resolved),
        resolved || 'none',
      );

      console.log('\nYouTube extraction (real request)');
      try {
        const metadata = await fetchYouTubeMetadata(runner, YOUTUBE_PROBE, YOUTUBE_PROBE_ID);
        check('metadata extraction', metadata.videoId === YOUTUBE_PROBE_ID, metadata.title);

        // The playable resolution is the step that actually needs the JS
        // runtime: a broken runtime fails here, not on --version.
        const track = createTrack({
          title: metadata.title,
          source: 'youtube',
          sourceId: metadata.videoId,
          originalInput: YOUTUBE_PROBE,
          requestedByUserId: 'diagnostic',
          canonicalUrl: metadata.canonicalUrl,
        });
        const source = await resolveYouTubePlayback(runner, track);
        check(
          'playable media resolution',
          source.input.startsWith('https://'),
          'direct URL hidden',
        );

        if (ffmpeg.available) {
          console.log('\nFFmpeg over the resolved source (no full download)');
          const bytes = await readSome(source.input, source.headers, ffmpegPath);
          check('produces Ogg/Opus from the remote source', bytes > 10_000, `${bytes} bytes`);
        }
      } catch (error) {
        const code = isProviderError(error) ? error.code : 'unknown';
        check('YouTube extraction', false, code);
      }

      console.log('\nSoundCloud extraction (real request)');
      try {
        const candidates = await searchSoundCloudCandidates(
          runner,
          'Scott Buckley Signal To Noise',
          5,
        );
        check('metadata-only search', candidates.length > 0, `${candidates.length} candidate(s)`);
      } catch (error) {
        const code = isProviderError(error) ? error.code : 'unknown';
        check('metadata-only search', false, code);
      }
    }
  } finally {
    runner.destroy();
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`NOT ready: ${failures.length} check(s) failed:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log('Ready for CFG Radio.');
}

/** Streams a couple of seconds through the real playback args, then stops. */
function readSome(
  input: string,
  headers: Readonly<Record<string, string>> | undefined,
  ffmpegPath: string,
): Promise<number> {
  const pipeline = FfmpegPipeline.start({
    ffmpegPath,
    inputPath: input,
    inputOptions: { headers, remote: true },
    logger,
  });
  return new Promise<number>((resolve, reject) => {
    let total = 0;
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pipeline.stop();
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() => {
        resolve(total);
      });
    }, 25_000);
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
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Host diagnostics crashed', error);
  process.exit(1);
}

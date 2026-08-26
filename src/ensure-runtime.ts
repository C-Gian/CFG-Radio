import 'dotenv/config';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ffmpegPathFromEnv, ytdlpPathFromEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { ensureYtDlp, parseYtDlpVersion } from './setup/ytdlp-bootstrap.js';
import { UnsupportedArchitectureError, YTDLP_VERSION } from './setup/ytdlp-release.js';

/**
 * Everything CFG Radio needs in place before the bot starts.
 *
 * It runs to completion and exits: no daemon, no supervisor, nothing resident.
 * The production start command is
 *   node dist/ensure-runtime.js && exec node dist/index.js
 * so the bot itself is the process that receives SIGTERM.
 *
 * A failure here exits non-zero and the bot never starts - better a clear
 * refusal than a crash loop with a missing dependency.
 */
const REQUIRED_NODE_MAJOR = 24;
const PROBE_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);
const logger = createLogger('info');

async function probe(command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function main(): Promise<void> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  logger.info(`Node ${process.versions.node} on ${process.platform}/${process.arch}`);
  if (!Number.isFinite(nodeMajor) || nodeMajor < REQUIRED_NODE_MAJOR) {
    throw new Error(
      `CFG Radio needs Node ${REQUIRED_NODE_MAJOR} or newer, this host has ${process.versions.node}`,
    );
  }

  // FFmpeg belongs to the host image: it is checked, never installed.
  const ffmpegPath = ffmpegPathFromEnv();
  let ffmpegBanner: string;
  try {
    ffmpegBanner = await probe(ffmpegPath, ['-hide_banner', '-version']);
  } catch (error) {
    throw new Error(
      `FFmpeg is not runnable ("${ffmpegPath}"). Install it in the image or set FFMPEG_PATH.`,
      { cause: error },
    );
  }
  const ffmpegVersion = ffmpegBanner.split('\n')[0]?.trim() ?? 'unknown';
  logger.info(`FFmpeg found: ${ffmpegVersion}`);
  if (!/--enable-libopus|\blibopus\b/.test(ffmpegBanner)) {
    logger.warn('This FFmpeg build does not advertise libopus; playback may fail');
  }

  const result = await ensureYtDlp({ logger }).catch(async (error: unknown) => {
    // No pinned build for this platform (a developer machine, typically): a
    // yt-dlp that is already installed is good enough to keep working, but it
    // is never silently treated as the pinned one.
    if (!(error instanceof UnsupportedArchitectureError)) {
      throw error;
    }
    const fallback = ytdlpPathFromEnv();
    await probe(fallback, ['--version']).catch(() => {
      throw error;
    });
    logger.warn(`${error.message} Using the yt-dlp already available at "${fallback}" instead.`);
    return { path: fallback, action: 'already-installed' as const, version: 'unpinned' };
  });

  const versionOutput = await probe(result.path, ['--version']).catch((error: unknown) => {
    throw new Error(`The installed yt-dlp could not be executed (${result.path})`, {
      cause: error,
    });
  });
  const reported = parseYtDlpVersion(versionOutput);
  if (result.version === YTDLP_VERSION && reported !== YTDLP_VERSION) {
    throw new Error(
      `yt-dlp reports version "${reported ?? 'unknown'}" but ${YTDLP_VERSION} was pinned`,
    );
  }
  logger.info(`yt-dlp ready: ${reported} (${result.action}) at ${result.path}`);

  // What the bot itself will resolve at startup must be what we just verified.
  const resolvedForBot = ytdlpPathFromEnv();
  if (resolvedForBot !== result.path) {
    logger.warn(
      `The bot will use "${resolvedForBot}" instead of the binary just verified. ` +
        'Unset YTDLP_PATH to use the pinned one.',
    );
  }
  logger.info('Runtime checks passed, starting CFG Radio');
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Runtime preparation failed');
  console.error(error instanceof Error ? `  ${error.message}` : String(error));
  if (error instanceof Error && error.cause instanceof Error) {
    console.error(`  cause: ${error.cause.message}`);
  }
  process.exit(1);
}

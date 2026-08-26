import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { downloadToBuffer } from './download.js';
import {
  YTDLP_VERSION,
  assetFor,
  downloadUrlFor,
  localYtDlpPath,
  type YtDlpAsset,
} from './ytdlp-release.js';
import type { Logger } from '../logger.js';

/** Owner rwx, group/other rx: executable for the container user. */
const EXECUTABLE_MODE = 0o755;

export type BootstrapAction = 'already-installed' | 'downloaded' | 'replaced';

export interface EnsureYtDlpResult {
  readonly path: string;
  readonly action: BootstrapAction;
  readonly version: string;
}

export interface EnsureYtDlpOptions {
  readonly logger: Logger;
  readonly platform?: string;
  readonly arch?: string;
  /** Overrides the install location; defaults to `<repo>/bin/yt-dlp`. */
  readonly targetPath?: string;
  /** Injected in tests so nothing is fetched over the network. */
  readonly download?: (url: string) => Promise<Buffer>;
}

export class YtDlpBootstrapError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'YtDlpBootstrapError';
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The checksum of an installed file, or `undefined` when it is not there. */
async function installedChecksum(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch {
    return undefined;
  }
}

/**
 * Makes sure the pinned yt-dlp binary is present and authentic.
 *
 * The install is atomic and fails closed: the download is verified against the
 * checksum published by the yt-dlp release *before* anything is put in place,
 * and a mismatch leaves the previous binary untouched. Nothing is ever passed
 * to a shell.
 */
export async function ensureYtDlp(options: EnsureYtDlpOptions): Promise<EnsureYtDlpResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const asset: YtDlpAsset = assetFor(platform, arch);
  const target = options.targetPath ?? localYtDlpPath();
  const download = options.download ?? ((url: string) => downloadToBuffer(url));

  const existing = await installedChecksum(target);
  if (existing === asset.sha256) {
    options.logger.info(`yt-dlp ${YTDLP_VERSION} already installed at ${target}`);
    // Permissions can be lost when files are restored or copied around.
    await ensureExecutable(target);
    return { path: target, action: 'already-installed', version: YTDLP_VERSION };
  }

  const action: BootstrapAction = existing === undefined ? 'downloaded' : 'replaced';
  options.logger.info(
    existing === undefined
      ? `Installing yt-dlp ${YTDLP_VERSION} (${asset.assetName}) into ${target}`
      : `Replacing the yt-dlp binary at ${target} with the pinned ${YTDLP_VERSION}`,
  );

  const url = downloadUrlFor(asset);
  let payload: Buffer;
  try {
    payload = await download(url);
  } catch (error) {
    throw new YtDlpBootstrapError(
      `Could not download yt-dlp ${YTDLP_VERSION} (${asset.assetName})`,
      { cause: error },
    );
  }

  const actual = sha256(payload);
  if (actual !== asset.sha256) {
    // Fail closed: never install or run an unverified binary.
    throw new YtDlpBootstrapError(
      `Checksum mismatch for ${asset.assetName}: expected ${asset.sha256}, got ${actual}. ` +
        'The binary was NOT installed.',
    );
  }

  // Temp file in the same directory, so the rename below is atomic.
  const temporary = `${target}.${process.pid}.download`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, payload, { mode: EXECUTABLE_MODE });
    await chmod(temporary, EXECUTABLE_MODE);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new YtDlpBootstrapError(`Could not install yt-dlp into ${target}`, { cause: error });
  }

  options.logger.info(`yt-dlp ${YTDLP_VERSION} installed and verified (sha256 ${actual})`);
  return { path: target, action, version: YTDLP_VERSION };
}

async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  try {
    await chmod(path, EXECUTABLE_MODE);
  } catch {
    // Not fatal on its own: the version probe that follows will tell.
  }
}

/** Parses the single line `yt-dlp --version` prints. */
export function parseYtDlpVersion(output: string): string | undefined {
  const line = output.trim().split('\n')[0]?.trim();
  return line !== undefined && /^\d{4}\.\d{2}\.\d{2}/.test(line) ? line : undefined;
}

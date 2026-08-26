import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The yt-dlp release CFG Radio is pinned to.
 *
 * Updating yt-dlp is a deliberate commit that changes this version *and* the
 * checksums below, so a deployment is always reproducible and never depends on
 * whatever the network happens to serve. `yt-dlp -U` is never run at startup.
 *
 * Checksums come from the SHA2-256SUMS file published by the release itself:
 * https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS
 */
export const YTDLP_VERSION = '2026.08.19';

export interface YtDlpAsset {
  /** Asset file name inside the GitHub release. */
  readonly assetName: string;
  /** Lowercase hex SHA-256 published by the release. */
  readonly sha256: string;
}

/**
 * Only architectures whose checksum is pinned are supported. Anything else
 * fails loudly instead of pretending to be multi-arch.
 */
export const YTDLP_ASSETS: Readonly<Record<string, YtDlpAsset>> = {
  x64: {
    assetName: 'yt-dlp_linux',
    sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
  },
  arm64: {
    assetName: 'yt-dlp_linux_aarch64',
    sha256: 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc',
  },
};

/** Directory the bootstrap installs into, relative to the repository root. */
export const LOCAL_BIN_DIR = 'bin';

// `<root>/src/setup` in development, `<root>/dist/setup` once built.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the bootstrap keeps the binary. Never hardcodes a host path. */
export function localYtDlpPath(root: string = packageRoot): string {
  return join(root, LOCAL_BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

export function packageRootDir(): string {
  return packageRoot;
}

export class UnsupportedArchitectureError extends Error {
  constructor(platform: string, arch: string) {
    super(
      `No pinned yt-dlp build for ${platform}/${arch}. ` +
        `Supported: linux/${Object.keys(YTDLP_ASSETS).join(', linux/')}. ` +
        'Install yt-dlp yourself and point YTDLP_PATH at it.',
    );
    this.name = 'UnsupportedArchitectureError';
  }
}

/**
 * The asset for a host.
 *
 * @throws {UnsupportedArchitectureError} when the platform/arch is not pinned.
 */
export function assetFor(platform: string, arch: string): YtDlpAsset {
  const asset = platform === 'linux' ? YTDLP_ASSETS[arch] : undefined;
  if (asset === undefined) {
    throw new UnsupportedArchitectureError(platform, arch);
  }
  return asset;
}

/** The official download URL for an asset. Built only from pinned constants. */
export function downloadUrlFor(asset: YtDlpAsset): string {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset.assetName}`;
}

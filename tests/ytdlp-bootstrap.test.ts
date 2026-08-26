import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  YtDlpBootstrapError,
  ensureYtDlp,
  parseYtDlpVersion,
} from '../src/setup/ytdlp-bootstrap.js';
import {
  UnsupportedArchitectureError,
  YTDLP_ASSETS,
  YTDLP_VERSION,
  assetFor,
  downloadUrlFor,
  localYtDlpPath,
} from '../src/setup/ytdlp-release.js';
import { fakeLogger } from './helpers/fake-transport.js';

/** A payload whose checksum matches what the release pins for x64. */
function pinnedPayload(): Buffer {
  // The tests cannot ship a 39 MB binary, so they pin their own bytes and
  // stub the expected checksum through the asset table instead.
  return Buffer.from('pretend this is the official yt-dlp binary');
}

const payload = pinnedPayload();
const payloadSha = createHash('sha256').update(payload).digest('hex');

let workDir: string;
let target: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'cfg-radio-bootstrap-'));
  target = join(workDir, 'bin', 'yt-dlp');
  // The release table is the single source of truth, so the test overrides the
  // expected checksum to match its own small payload.
  vi.spyOn(YTDLP_ASSETS, 'x64', 'get').mockReturnValue({
    assetName: 'yt-dlp_linux',
    sha256: payloadSha,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workDir, { recursive: true, force: true });
});

function options(download: (url: string) => Promise<Buffer>) {
  return { logger: fakeLogger(), platform: 'linux', arch: 'x64', targetPath: target, download };
}

describe('pinned release metadata', () => {
  it('pins a checksum for every supported architecture', () => {
    for (const [arch, asset] of Object.entries(YTDLP_ASSETS)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.assetName).toContain('yt-dlp_linux');
      expect(arch).toMatch(/^(x64|arm64)$/);
    }
  });

  it('builds the official GitHub release URL for the pinned version', () => {
    const url = downloadUrlFor(assetFor('linux', 'x64'));

    expect(url).toBe(
      `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux`,
    );
    expect(url.startsWith('https://github.com/yt-dlp/yt-dlp/releases/download/')).toBe(true);
  });

  it('refuses architectures it cannot verify instead of guessing', () => {
    expect(() => assetFor('linux', 'ppc64')).toThrow(UnsupportedArchitectureError);
    expect(() => assetFor('darwin', 'arm64')).toThrow(UnsupportedArchitectureError);
    expect(() => assetFor('win32', 'x64')).toThrow(/Supported: linux/);
  });

  it('keeps the install path inside the repository, not a host path', () => {
    const path = localYtDlpPath('/srv/app').replaceAll('\\', '/');

    expect(path).toMatch(/^\/srv\/app\/bin\/yt-dlp(\.exe)?$/);
  });
});

describe('ensureYtDlp', () => {
  it('downloads, verifies and installs the binary atomically', async () => {
    const download = vi.fn().mockResolvedValue(payload);

    const result = await ensureYtDlp(options(download));

    expect(result).toMatchObject({ action: 'downloaded', version: YTDLP_VERSION, path: target });
    expect(await readFile(target)).toEqual(payload);
    expect(download).toHaveBeenCalledWith(
      `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux`,
    );
    // No temp file survives a successful install.
    expect(await readdir(join(workDir, 'bin'))).toEqual(['yt-dlp']);
  });

  it('makes the installed binary executable', async () => {
    await ensureYtDlp(options(vi.fn().mockResolvedValue(payload)));

    const mode = (await stat(target)).mode & 0o777;
    // Windows does not model the permission bits, so only assert on POSIX.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o755);
    }
  });

  it('does nothing when the correct binary is already installed', async () => {
    const download = vi.fn().mockResolvedValue(payload);
    await ensureYtDlp(options(download));
    download.mockClear();

    const result = await ensureYtDlp(options(download));

    expect(result.action).toBe('already-installed');
    expect(download).not.toHaveBeenCalled();
  });

  it('replaces a binary of the wrong version', async () => {
    const download = vi.fn().mockResolvedValue(payload);
    await writeFile(join(workDir, 'bin', 'yt-dlp'), 'an older yt-dlp', {
      flag: 'w',
      mode: 0o755,
    }).catch(async () => {
      // The directory may not exist yet on the first run.
      await ensureYtDlp(options(download));
      await writeFile(target, 'an older yt-dlp');
    });

    const result = await ensureYtDlp(options(download));

    expect(result.action).toBe('replaced');
    expect(await readFile(target)).toEqual(payload);
  });

  it('replaces a corrupted binary', async () => {
    const download = vi.fn().mockResolvedValue(payload);
    await ensureYtDlp(options(download));
    await writeFile(target, Buffer.from('truncated / corrupted'));
    download.mockClear();

    const result = await ensureYtDlp(options(download));

    expect(result.action).toBe('replaced');
    expect(download).toHaveBeenCalledTimes(1);
    expect(await readFile(target)).toEqual(payload);
  });

  it('fails closed on a checksum mismatch and installs nothing', async () => {
    const download = vi.fn().mockResolvedValue(Buffer.from('a different binary'));

    await expect(ensureYtDlp(options(download))).rejects.toThrow(/Checksum mismatch/);
    await expect(readFile(target)).rejects.toThrow();
  });

  it('keeps the previous good binary when a replacement fails verification', async () => {
    await ensureYtDlp(options(vi.fn().mockResolvedValue(payload)));
    await writeFile(target, Buffer.from('corrupted'));

    await expect(
      ensureYtDlp(options(vi.fn().mockResolvedValue(Buffer.from('still wrong')))),
    ).rejects.toThrow(YtDlpBootstrapError);

    // The bad download never made it onto disk.
    expect(await readFile(target)).toEqual(Buffer.from('corrupted'));
  });

  it('leaves no temporary file behind after a failed download', async () => {
    const download = vi.fn().mockRejectedValue(new Error('connection reset'));

    await expect(ensureYtDlp(options(download))).rejects.toThrow(/Could not download yt-dlp/);

    const entries = await readdir(join(workDir, 'bin')).catch(() => []);
    expect(entries.filter((entry) => entry.includes('download'))).toEqual([]);
  });

  it('leaves no temporary file behind after a checksum mismatch', async () => {
    await ensureYtDlp(options(vi.fn().mockResolvedValue(payload)));
    // Corrupt it so the next call really re-downloads instead of skipping.
    await writeFile(target, Buffer.from('corrupted'));

    await expect(
      ensureYtDlp(options(vi.fn().mockResolvedValue(Buffer.from('wrong')))),
    ).rejects.toThrow(/Checksum mismatch/);

    expect(await readdir(join(workDir, 'bin'))).toEqual(['yt-dlp']);
  });

  it('refuses an unsupported architecture before downloading anything', async () => {
    const download = vi.fn();

    await expect(ensureYtDlp({ ...options(download), arch: 'mips' })).rejects.toThrow(
      UnsupportedArchitectureError,
    );
    expect(download).not.toHaveBeenCalled();
  });
});

describe('parseYtDlpVersion', () => {
  it.each([
    ['2026.08.19\n', '2026.08.19'],
    ['2026.08.19', '2026.08.19'],
    ['  2026.08.19  \nextra noise', '2026.08.19'],
  ])('parses %j', (output, expected) => {
    expect(parseYtDlpVersion(output)).toBe(expected);
  });

  it.each(['', 'not a version', 'yt-dlp version 2026'])('rejects %j', (output) => {
    expect(parseYtDlpVersion(output)).toBeUndefined();
  });
});

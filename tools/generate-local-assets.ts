/**
 * Regenerates every synthetic asset in `assets/`.
 *
 * The recipes live in `src/audio/local-catalog.ts`, so the catalog and the
 * files on disk can never drift apart. Everything is computer generated sine
 * tones - no copyrighted material is involved - and the output is
 * deterministic for a given FFmpeg build.
 *
 * Usage: npm run assets:generate
 */
import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

import {
  ASSETS_DIR,
  LOCAL_ASSETS,
  localAssetPath,
  type LocalAsset,
} from '../src/audio/local-catalog.js';
import { ffmpegPathFromEnv } from '../src/config/env.js';

const FADE_SECONDS = 0.05;

function buildArgs(asset: LocalAsset, outputPath: string): string[] {
  const inputs = asset.notes.flatMap((frequency) => [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${asset.noteSeconds}:sample_rate=48000`,
  ]);

  const totalSeconds = asset.notes.length * asset.noteSeconds;
  const concatInputs = asset.notes.map((_note, index) => `[${index}:a]`).join('');
  const filter = [
    `${concatInputs}concat=n=${asset.notes.length}:v=0:a=1[joined]`,
    `[joined]volume=0.35,afade=t=in:st=0:d=${FADE_SECONDS},` +
      `afade=t=out:st=${totalSeconds - FADE_SECONDS}:d=${FADE_SECONDS}[out]`,
  ].join(';');

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-c:a',
    'libopus',
    '-b:a',
    '64k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-application',
    'audio',
    '-f',
    'opus',
    outputPath,
  ];
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? -1);
    });
  });
}

async function main(): Promise<void> {
  // No Discord credentials needed to regenerate audio assets.
  const ffmpegPath = ffmpegPathFromEnv();
  await mkdir(ASSETS_DIR, { recursive: true });

  for (const asset of LOCAL_ASSETS) {
    const outputPath = localAssetPath(asset);
    const exitCode = await runFfmpeg(ffmpegPath, buildArgs(asset, outputPath));
    if (exitCode !== 0) {
      throw new Error(`FFmpeg exited with code ${exitCode} while generating ${asset.fileName}`);
    }
    console.log(
      `Generated ${asset.fileName} (${asset.durationMs / 1000}s, ${asset.notes.length} notes)`,
    );
  }
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Could not generate the local assets', error);
  process.exit(1);
}

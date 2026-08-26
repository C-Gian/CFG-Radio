/**
 * Regenerates `assets/test-tone.opus`.
 *
 * The asset is 100% synthetic: four sine tones (A4, C#5, E5, A5) of two
 * seconds each, faded in and out, encoded as Ogg/Opus 48 kHz stereo. It exists
 * only so `/playlocal` has a deterministic, license-free sound to push through
 * the voice pipeline.
 *
 * Usage: npm run assets:tone
 */
import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpegPathFromEnv } from '../src/config/env.js';
import { TEST_TONE_PATH } from '../src/audio/test-tone.js';

const NOTES = [
  { name: 'A4', frequency: 440 },
  { name: 'C#5', frequency: 554 },
  { name: 'E5', frequency: 659 },
  { name: 'A5', frequency: 880 },
] as const;

const NOTE_SECONDS = 2;
const TOTAL_SECONDS = NOTES.length * NOTE_SECONDS;

function buildArgs(outputPath: string): string[] {
  const inputs = NOTES.flatMap((note) => [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${note.frequency}:duration=${NOTE_SECONDS}:sample_rate=48000`,
  ]);

  const concatInputs = NOTES.map((_note, index) => `[${index}:a]`).join('');
  const filter = [
    `${concatInputs}concat=n=${NOTES.length}:v=0:a=1[joined]`,
    `[joined]volume=0.35,afade=t=in:st=0:d=0.05,afade=t=out:st=${TOTAL_SECONDS - 0.15}:d=0.15[out]`,
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

async function main(): Promise<void> {
  // No Discord credentials needed to regenerate an audio asset.
  const ffmpegPath = ffmpegPathFromEnv();
  await mkdir(dirname(TEST_TONE_PATH), { recursive: true });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(ffmpegPath, buildArgs(TEST_TONE_PATH), {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve(code ?? -1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`FFmpeg exited with code ${exitCode}`);
  }

  console.log(
    `Generated ${TEST_TONE_PATH} (${TOTAL_SECONDS}s: ${NOTES.map((note) => note.name).join(' - ')})`,
  );
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Could not generate the test tone', error);
  process.exit(1);
}

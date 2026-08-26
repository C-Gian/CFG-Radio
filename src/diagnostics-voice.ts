import 'dotenv/config';

import { generateDependencyReport } from '@discordjs/voice';
import { getCiphers } from 'node:crypto';

import { FfmpegPipeline, collectPipelineOutput, probeFfmpeg } from './audio/ffmpeg.js';
import {
  ASSETS_DIR,
  LOCAL_ASSETS,
  assertAssetExists,
  localAssetPath,
  type LocalAsset,
} from './audio/local-catalog.js';
import { ffmpegPathFromEnv } from './config/env.js';
import { createLogger } from './logger.js';

/** Ciphers Discord voice can use without any native dependency. */
const REQUIRED_CIPHERS = ['aes-256-gcm'];
const OGG_MAGIC = 'OggS';

/**
 * Voice readiness check: dependency report, FFmpeg build, crypto support and a
 * real run of the playback pipeline over the bundled test tone.
 *
 * No Discord connection, no network, no secrets - it never even reads the
 * token.
 */
async function main(): Promise<void> {
  const logger = createLogger('info');
  const ffmpegPath = ffmpegPathFromEnv();
  const failures: string[] = [];

  console.log('=== @discordjs/voice dependency report ===');
  console.log(generateDependencyReport());

  console.log('=== Encryption ===');
  const ciphers = getCiphers();
  for (const cipher of REQUIRED_CIPHERS) {
    const available = ciphers.includes(cipher);
    console.log(`  ${cipher}: ${available ? 'available (node:crypto)' : 'MISSING'}`);
    if (!available) {
      failures.push(`Node does not provide the ${cipher} cipher`);
    }
  }

  console.log('=== FFmpeg ===');
  const probe = await probeFfmpeg(ffmpegPath);
  console.log(`  executable: ${ffmpegPath}`);
  console.log(
    `  version: ${probe.available ? probe.version : `NOT AVAILABLE (${probe.error ?? ''})`}`,
  );
  console.log(`  libopus encoder: ${probe.hasLibopus ? 'yes' : 'NO'}`);
  if (!probe.available) {
    failures.push('FFmpeg is not runnable');
  } else if (!probe.hasLibopus) {
    failures.push('This FFmpeg build has no libopus encoder');
  }

  console.log('=== Local audio catalog ===');
  console.log(`  directory: ${ASSETS_DIR}`);
  const readable: LocalAsset[] = [];
  for (const asset of LOCAL_ASSETS) {
    try {
      await assertAssetExists(localAssetPath(asset));
      console.log(`  ${asset.fileName}: readable (${asset.durationMs / 1000}s)`);
      readable.push(asset);
    } catch (error) {
      console.log(`  ${asset.fileName}: MISSING`);
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (probe.available && failures.length === 0) {
    console.log('=== Playback pipeline (FFmpeg -> Ogg/Opus) ===');
    for (const asset of readable) {
      const pipeline = FfmpegPipeline.start({
        ffmpegPath,
        inputPath: localAssetPath(asset),
        logger,
      });
      try {
        const output = await collectPipelineOutput(pipeline);
        const isOgg = output.subarray(0, 4).toString('ascii') === OGG_MAGIC;
        console.log(
          `  ${asset.fileName}: ${output.byteLength} bytes, Ogg: ${isOgg ? 'yes' : 'NO'}`,
        );
        if (output.byteLength === 0 || !isOgg) {
          failures.push(`${asset.fileName} did not produce a valid Ogg/Opus stream`);
        }
      } finally {
        pipeline.stop();
      }
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`Voice diagnostics FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Voice diagnostics OK.');
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Voice diagnostics crashed', error);
  process.exit(1);
}

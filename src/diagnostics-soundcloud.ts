import 'dotenv/config';

import { ffmpegPathFromEnv, ytdlpPathFromEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { createTrack } from './player/track.js';
import { searchSoundCloudCandidates } from './soundcloud/candidate.js';
import {
  SOUNDCLOUD_DIAGNOSTIC_QUERY,
  SOUNDCLOUD_DIAGNOSTIC_TRACK,
  probeSoundCloudWithFfmpeg,
} from './soundcloud/diagnostic-probe.js';
import { chooseSoundCloudCandidate } from './soundcloud/matching.js';
import { resolveSoundCloudPlayback } from './soundcloud/playback.js';
import { YtDlpRunner } from './youtube/ytdlp.js';

async function main(): Promise<void> {
  const logger = createLogger('info');
  const runner = new YtDlpRunner({ ytdlpPath: ytdlpPathFromEnv(), logger, timeoutMs: 60_000 });
  try {
    console.log('=== SoundCloud guest extraction ===');
    console.log(`  yt-dlp version: ${await runner.version()}`);
    console.log('  authentication: none');
    console.log('  cookies: none');

    const candidates = await searchSoundCloudCandidates(runner, SOUNDCLOUD_DIAGNOSTIC_QUERY);
    console.log('=== SoundCloud search ===');
    console.log('  syntax: scsearch5:<query>');
    console.log(`  metadata candidates: ${candidates.length}`);
    for (const candidate of candidates) {
      console.log(
        `  ${candidate.id}: ${candidate.title} — ${candidate.artist ?? '(unknown artist)'} ` +
          `(${candidate.durationMs ?? 'unknown'}ms)`,
      );
    }

    const track = createTrack({
      ...SOUNDCLOUD_DIAGNOSTIC_TRACK,
      source: 'youtube',
      sourceId: 'diagnostic-youtube-identity',
      originalInput: 'diagnostic fixture',
      requestedByUserId: 'diagnostic',
    });
    const decision = chooseSoundCloudCandidate(track, candidates);
    if (!decision.accepted) {
      throw new Error(`No confident diagnostic candidate (${decision.reason})`);
    }
    console.log('=== Candidate parsing and selection ===');
    console.log(`  selected id: ${decision.selected.id}`);
    console.log(`  selected page: ${decision.selected.canonicalUrl}`);

    const source = await resolveSoundCloudPlayback(runner, decision.selected);
    console.log('=== Playable resolution and FFmpeg ===');
    console.log(`  runtime source: ${source.kind} (direct URL intentionally hidden)`);
    console.log(`  forwarded headers: ${Object.keys(source.headers ?? {}).join(', ') || '(none)'}`);
    const bytes = await probeSoundCloudWithFfmpeg(source, ffmpegPathFromEnv(), logger);
    console.log(`  Ogg/Opus bytes read: ${bytes}`);
    console.log('  cleanup: complete');
    console.log('\nSoundCloud diagnostics OK.');
  } finally {
    runner.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] SoundCloud diagnostics failed', error);
  process.exit(1);
}

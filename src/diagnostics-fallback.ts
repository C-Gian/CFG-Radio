import 'dotenv/config';

import { ffmpegPathFromEnv, ytdlpPathFromEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { ProviderError } from './player/provider-error.js';
import { createTrack } from './player/track.js';
import { searchSoundCloudCandidates } from './soundcloud/candidate.js';
import {
  SOUNDCLOUD_DIAGNOSTIC_QUERY,
  SOUNDCLOUD_DIAGNOSTIC_TRACK,
  probeSoundCloudWithFfmpeg,
} from './soundcloud/diagnostic-probe.js';
import { isSoundCloudFallbackEligible } from './soundcloud/fallback.js';
import { chooseSoundCloudCandidate } from './soundcloud/matching.js';
import { resolveSoundCloudPlayback } from './soundcloud/playback.js';
import { YtDlpRunner } from './youtube/ytdlp.js';

async function main(): Promise<void> {
  const logger = createLogger('info');
  const runner = new YtDlpRunner({ ytdlpPath: ytdlpPathFromEnv(), logger, timeoutMs: 60_000 });
  try {
    const track = createTrack({
      ...SOUNDCLOUD_DIAGNOSTIC_TRACK,
      source: 'youtube',
      sourceId: 'diagnostic-youtube-identity',
      canonicalUrl: 'https://www.youtube.com/watch?v=diagnostic',
      originalInput: 'diagnostic fixture',
      requestedByUserId: 'diagnostic',
    });
    const simulatedFailure = new ProviderError('unavailable', 'simulated primary failure');
    const request = { track, stage: 'resolution' as const, error: simulatedFailure };

    console.log('=== Simulated primary attempt ===');
    console.log(`  original: ${track.title}`);
    console.log(`  artist: ${track.artist ?? '(unknown)'}`);
    console.log(`  duration: ${track.durationMs ?? '(unknown)'}ms`);
    console.log('  YouTube result: intentionally simulated unavailable');
    console.log(`  fallback eligible: ${isSoundCloudFallbackEligible(request) ? 'yes' : 'NO'}`);

    const candidates = await searchSoundCloudCandidates(runner, SOUNDCLOUD_DIAGNOSTIC_QUERY);
    const decision = chooseSoundCloudCandidate(track, candidates);
    console.log('=== Candidates ===');
    for (const [index, score] of decision.scored.entries()) {
      console.log(
        `${index + 1}. ${score.candidate.title} — ${score.candidate.artist ?? '(unknown)'}`,
      );
      console.log(
        `   title=${score.titleScore} artist=${score.artistScore} ` +
          `duration=${score.durationScore} versionPenalty=${score.versionPenalty} ` +
          `final=${score.finalScore}`,
      );
    }

    console.log('=== Decision ===');
    console.log(`  ${decision.accepted ? 'ACCEPT' : 'REJECT'}: ${decision.reason}`);
    if (!decision.accepted) {
      throw new Error(`Fallback diagnostic rejected every candidate (${decision.reason})`);
    }
    console.log(`  selected page: ${decision.selected.canonicalUrl}`);
    console.log('  direct media URL: intentionally hidden');

    const source = await resolveSoundCloudPlayback(runner, decision.selected);
    const bytes = await probeSoundCloudWithFfmpeg(source, ffmpegPathFromEnv(), logger);
    console.log(`  FFmpeg Ogg/Opus bytes: ${bytes}`);
    console.log('  cleanup: complete');
    console.log('\nFallback diagnostics OK.');
  } finally {
    runner.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] Fallback diagnostics failed', error);
  process.exit(1);
}

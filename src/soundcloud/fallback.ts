import { isProviderError } from '../player/provider-error.js';
import type { PlaybackFallbackRequest, PlaybackFallbackResolver } from '../player/transport.js';
import type { Logger } from '../logger.js';
import type { YtDlpRunner } from '../youtube/ytdlp.js';
import { DEFAULT_SOUNDCLOUD_SEARCH_LIMIT, searchSoundCloudCandidates } from './candidate.js';
import { buildSoundCloudSearchQuery, chooseSoundCloudCandidate } from './matching.js';
import { resolveSoundCloudPlayback } from './playback.js';

export const FALLBACK_ELIGIBLE_YOUTUBE_ERRORS = new Set([
  'unavailable',
  'rate_limited',
  'extractor_failed',
  'timeout',
] as const);

export interface SoundCloudFallbackOptions {
  readonly ytdlp: YtDlpRunner;
  readonly logger: Logger;
  readonly searchLimit?: number;
}

export function isSoundCloudFallbackEligible(request: PlaybackFallbackRequest): boolean {
  if (request.track.source !== 'youtube') {
    return false;
  }
  if (request.stage === 'start') {
    // PlaybackTransport.play() resolves only after Playing, so a rejection is
    // explicitly a pre-start failure. Later errors arrive via onPlaybackError.
    return true;
  }
  return (
    isProviderError(request.error) &&
    FALLBACK_ELIGIBLE_YOUTUBE_ERRORS.has(request.error.code as never)
  );
}

export function createSoundCloudFallbackResolver(
  options: SoundCloudFallbackOptions,
): PlaybackFallbackResolver {
  const limit = options.searchLimit ?? DEFAULT_SOUNDCLOUD_SEARCH_LIMIT;
  return async (request) => {
    if (!isSoundCloudFallbackEligible(request)) {
      return undefined;
    }

    const { track } = request;
    options.logger.info(
      `YouTube playback failed at ${request.stage} in ${track.sourceId}; evaluating SoundCloud fallback`,
    );

    let candidates;
    try {
      candidates = await searchSoundCloudCandidates(
        options.ytdlp,
        buildSoundCloudSearchQuery(track),
        limit,
      );
    } catch (error) {
      options.logger.warn(`SoundCloud fallback search failed for YouTube ${track.sourceId}`, error);
      return undefined;
    }

    options.logger.info(
      `SoundCloud search returned ${candidates.length} candidate(s) for YouTube ${track.sourceId}`,
    );
    const decision = chooseSoundCloudCandidate(track, candidates);
    for (const score of decision.scored) {
      options.logger.debug(
        `SoundCloud candidate ${score.candidate.id} "${score.candidate.title}": ` +
          `title=${score.titleScore}, artist=${score.artistScore}, duration=${score.durationScore}, ` +
          `versionPenalty=${score.versionPenalty}, final=${score.finalScore}`,
      );
    }

    if (!decision.accepted) {
      options.logger.info(
        `No confident SoundCloud fallback candidate for YouTube ${track.sourceId} (${decision.reason})`,
      );
      return undefined;
    }

    options.logger.info(
      `SoundCloud fallback selected for YouTube ${track.sourceId}: candidate ` +
        `${decision.selected.id}, score ${decision.score.finalScore}`,
    );
    try {
      return await resolveSoundCloudPlayback(options.ytdlp, decision.selected);
    } catch (error) {
      // M7 tries exactly one winning candidate and never falls through to a
      // second result or a new search.
      options.logger.warn(
        `Selected SoundCloud fallback ${decision.selected.id} could not be resolved`,
        error,
      );
      return undefined;
    }
  };
}

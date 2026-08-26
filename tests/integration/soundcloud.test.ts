import { afterAll, describe, expect, it } from 'vitest';

import { ffmpegPathFromEnv, ytdlpPathFromEnv } from '../../src/config/env.js';
import { createTrack } from '../../src/player/track.js';
import { searchSoundCloudCandidates } from '../../src/soundcloud/candidate.js';
import {
  SOUNDCLOUD_DIAGNOSTIC_QUERY,
  SOUNDCLOUD_DIAGNOSTIC_TRACK,
  probeSoundCloudWithFfmpeg,
} from '../../src/soundcloud/diagnostic-probe.js';
import { chooseSoundCloudCandidate } from '../../src/soundcloud/matching.js';
import { resolveSoundCloudPlayback } from '../../src/soundcloud/playback.js';
import { YtDlpRunner } from '../../src/youtube/ytdlp.js';
import { fakeLogger } from '../helpers/fake-transport.js';

const logger = fakeLogger();
const runner = new YtDlpRunner({ ytdlpPath: ytdlpPathFromEnv(), logger, timeoutMs: 60_000 });

afterAll(() => {
  runner.destroy();
});

describe('SoundCloud guest fallback path (live)', () => {
  it('searches metadata, selects confidently, resolves one source and streams through FFmpeg', async () => {
    const candidates = await searchSoundCloudCandidates(runner, SOUNDCLOUD_DIAGNOSTIC_QUERY);
    expect(candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(candidates)).not.toMatch(/(?:m3u8|sndcdn|media\.soundcloud)/i);

    const track = createTrack({
      ...SOUNDCLOUD_DIAGNOSTIC_TRACK,
      source: 'youtube',
      sourceId: 'integration-youtube-identity',
      originalInput: 'integration fixture',
      requestedByUserId: 'integration',
    });
    const decision = chooseSoundCloudCandidate(track, candidates);
    expect(decision.accepted).toBe(true);
    if (!decision.accepted) return;

    const source = await resolveSoundCloudPlayback(runner, decision.selected);
    expect(source.kind).toBe('url');
    expect(source.input).toMatch(/^https:\/\//);
    expect(Object.keys(source.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'cookie',
    );
    expect(Object.keys(source.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'authorization',
    );

    const bytes = await probeSoundCloudWithFfmpeg(source, ffmpegPathFromEnv(), logger);
    expect(bytes).toBeGreaterThan(30_000);
  });
});

import { describe, expect, it } from 'vitest';

import { createTrack, type Track } from '../src/player/track.js';
import type { SoundCloudCandidate } from '../src/soundcloud/candidate.js';
import {
  MIN_MATCH_SCORE,
  MIN_WINNER_MARGIN,
  chooseSoundCloudCandidate,
  extractVersionTags,
  normalizeMusicText,
  scoreSoundCloudCandidate,
} from '../src/soundcloud/matching.js';

function youtubeTrack(
  title: string,
  artist = 'Linkin Park',
  durationMs: number | undefined = 186_000,
): Track {
  return createTrack({
    title,
    artist,
    durationMs,
    source: 'youtube',
    sourceId: 'youtube-id',
    originalInput: 'https://www.youtube.com/watch?v=youtube-id',
    canonicalUrl: 'https://www.youtube.com/watch?v=youtube-id',
    requestedByUserId: 'user-1',
  });
}

function candidate(
  title: string,
  artist = 'Linkin Park',
  durationMs: number | undefined = 186_000,
  id = title,
): SoundCloudCandidate {
  return {
    id,
    title,
    trackName: title,
    artist,
    durationMs,
    canonicalUrl: `https://soundcloud.com/test/${encodeURIComponent(id)}`,
    permalink: id,
  };
}

describe('SoundCloud matching normalization', () => {
  it('folds Unicode, punctuation, whitespace and feat variants', () => {
    expect(normalizeMusicText('  Beyoncé — Song (Ft. Guest)  ')).toBe('beyonce song feat guest');
  });

  it('detects every protected musical version marker', () => {
    expect(
      extractVersionTags(
        'Live Acoustic Remix Remastered Instrumental Karaoke Cover Nightcore ' +
          'Sped-Up Slowed Reverb Radio Edit Extended Demo Tribute Studio Version',
      ),
    ).toEqual([
      'live',
      'acoustic',
      'remix',
      'remastered',
      'instrumental',
      'karaoke',
      'cover',
      'nightcore',
      'sped-up',
      'slowed',
      'reverb',
      'radio-edit',
      'extended',
      'demo',
      'tribute',
      'studio',
    ]);
  });
});

describe('SoundCloud matching accepts confident identities', () => {
  it.each([
    [youtubeTrack('Linkin Park - Numb'), candidate('Numb')],
    [youtubeTrack('Linkin Park - Numb (Official Video)'), candidate('Linkin Park - Numb')],
    [
      youtubeTrack('Artist - Song ft. Guest', 'Artist', 200_000),
      candidate('Song (feat. Guest)', 'Artist', 203_000),
    ],
  ])('accepts matching title, artist, duration and harmless presentation noise', (track, item) => {
    const decision = chooseSoundCloudCandidate(track, [item]);
    expect(decision.accepted).toBe(true);
    if (decision.accepted) {
      expect(decision.score.finalScore).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    }
  });

  it('accepts missing duration only with excellent title and artist evidence', () => {
    const decision = chooseSoundCloudCandidate(youtubeTrack('Linkin Park - Numb'), [
      candidate('Numb', 'Linkin Park', undefined),
    ]);

    expect(decision.accepted).toBe(true);
  });
});

describe('SoundCloud matching rejects risky substitutions', () => {
  it.each([
    ['Numb', 'Numb (Nightcore)'],
    ['Numb (Studio Version)', 'Numb Live'],
    ['Song', 'Song Acoustic'],
    ['Song', 'Song Remix'],
    ['Song', 'Song Cover'],
    ['Song', 'Song Instrumental'],
    ['Song', 'Song Karaoke'],
    ['Song', 'Song Slowed + Reverb'],
    ['Song', 'Song Radio Edit'],
    ['Song', 'Song Extended'],
  ])('rejects version mismatch: %s vs %s', (youtubeTitle, soundCloudTitle) => {
    const score = scoreSoundCloudCandidate(
      youtubeTrack(youtubeTitle, 'Artist', 200_000),
      candidate(soundCloudTitle, 'Artist', 200_000),
    );

    expect(score.eligible).toBe(false);
    expect(score.versionPenalty).toBeGreaterThan(0);
  });

  it('rejects an identical title from a different artist', () => {
    const score = scoreSoundCloudCandidate(
      youtubeTrack('Numb'),
      candidate('Numb', 'Totally Different Artist'),
    );

    expect(score.eligible).toBe(false);
    expect(score.rejectionReasons).toContain('artist similarity is too low');
  });

  it('rejects a preview-length candidate for a full song', () => {
    const score = scoreSoundCloudCandidate(
      youtubeTrack('Numb', 'Linkin Park', 240_000),
      candidate('Numb', 'Linkin Park', 30_000),
    );

    expect(score.eligible).toBe(false);
    expect(score.rejectionReasons).toContain('duration differs too much');
  });

  it('rejects an ambiguous winner inside the documented margin', () => {
    const first = candidate('Numb', 'Linkin Park', 186_000, 'first');
    const second = candidate('Numb', 'Linkin Park', 188_000, 'second');
    const decision = chooseSoundCloudCandidate(youtubeTrack('Numb'), [first, second]);

    expect(MIN_WINNER_MARGIN).toBeGreaterThan(0);
    expect(decision).toMatchObject({ accepted: false, reason: 'ambiguous' });
  });

  it('rejects weak evidence when artist and duration are both missing', () => {
    const item = { ...candidate('Numb-ish', 'placeholder', undefined), artist: undefined };
    const decision = chooseSoundCloudCandidate(youtubeTrack('Numb'), [item]);

    expect(decision.accepted).toBe(false);
  });
});

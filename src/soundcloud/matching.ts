import type { Track } from '../player/track.js';
import type { SoundCloudCandidate } from './candidate.js';

export const MIN_MATCH_SCORE = 0.86;
export const MIN_WINNER_MARGIN = 0.08;

const VERSION_PATTERNS = {
  live: /\b(?:live|concert)\b/,
  acoustic: /\b(?:acoustic|unplugged)\b/,
  remix: /\bremix(?:ed)?\b/,
  remastered: /\bremaster(?:ed)?\b/,
  instrumental: /\binstrumental\b/,
  karaoke: /\bkaraoke\b/,
  cover: /\bcover\b/,
  nightcore: /\bnightcore\b/,
  'sped-up': /\bsped\s+up\b/,
  slowed: /\bslowed\b/,
  reverb: /\breverb(?:ed)?\b/,
  'radio-edit': /\bradio\s+edit\b/,
  extended: /\bextended\b/,
  demo: /\bdemo\b/,
  tribute: /\btribute\b/,
  studio: /\bstudio(?:\s+version)?\b/,
} as const;

export type VersionTag = keyof typeof VERSION_PATTERNS;

export interface MatchScore {
  readonly candidate: SoundCloudCandidate;
  readonly titleScore: number;
  readonly artistScore: number;
  readonly durationScore: number;
  readonly versionPenalty: number;
  readonly finalScore: number;
  readonly targetVersions: readonly VersionTag[];
  readonly candidateVersions: readonly VersionTag[];
  readonly eligible: boolean;
  readonly rejectionReasons: readonly string[];
}

export type MatchDecision =
  | {
      readonly accepted: true;
      readonly selected: SoundCloudCandidate;
      readonly score: MatchScore;
      readonly scored: readonly MatchScore[];
      readonly reason: 'confident-match';
    }
  | {
      readonly accepted: false;
      readonly scored: readonly MatchScore[];
      readonly reason: 'no-candidates' | 'below-threshold' | 'ambiguous';
    };

interface PreparedIdentity {
  readonly title: string;
  readonly artist: string | undefined;
  readonly versions: readonly VersionTag[];
}

export function normalizeMusicText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\b(?:featuring|feat\.?|ft\.?)\b/g, 'feat')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function extractVersionTags(value: string): readonly VersionTag[] {
  const normalized = normalizeMusicText(value);
  return (Object.entries(VERSION_PATTERNS) as [VersionTag, RegExp][])
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([tag]) => tag);
}

/** Deterministic token/character similarity in the 0..1 range. */
export function musicTextSimilarity(left: string, right: string): number {
  const a = normalizeMusicText(left);
  const b = normalizeMusicText(right);
  if (a === '' || b === '') {
    return 0;
  }
  if (a === b) {
    return 1;
  }

  const tokenScore = diceCoefficient(new Set(a.split(' ')), new Set(b.split(' ')));
  const characterScore = diceCoefficient(characterBigrams(a), characterBigrams(b));
  return round(0.75 * tokenScore + 0.25 * characterScore);
}

export function scoreSoundCloudCandidate(track: Track, candidate: SoundCloudCandidate): MatchScore {
  const target = prepareIdentity(track.title, track.artist);
  const candidateIdentity = prepareIdentity(
    candidate.trackName ?? candidate.title,
    candidate.artist,
  );
  const titleScore = musicTextSimilarity(target.title, candidateIdentity.title);
  const artistScore = scoreArtist(target.artist, candidateIdentity.artist);
  const duration = scoreDuration(track.durationMs, candidate.durationMs);
  const versionMismatch = symmetricDifference(target.versions, candidateIdentity.versions);
  const versionPenalty = versionMismatch.length > 0 ? 0.65 : 0;
  const finalScore = round(
    Math.max(0, 0.5 * titleScore + 0.35 * artistScore + 0.15 * duration.score - versionPenalty),
  );

  const rejectionReasons: string[] = [];
  if (versionMismatch.length > 0) {
    rejectionReasons.push(`version mismatch: ${versionMismatch.join(', ')}`);
  }
  if (titleScore < 0.78) {
    rejectionReasons.push('title similarity is too low');
  }
  if (target.artist !== undefined && candidateIdentity.artist !== undefined && artistScore < 0.65) {
    rejectionReasons.push('artist similarity is too low');
  }
  if (duration.hardMismatch) {
    rejectionReasons.push('duration differs too much');
  }
  if (
    (target.artist === undefined || candidateIdentity.artist === undefined) &&
    (titleScore < 0.94 || duration.score < 0.85)
  ) {
    rejectionReasons.push('missing artist requires near-exact title and duration');
  }
  if (
    (track.durationMs === undefined || candidate.durationMs === undefined) &&
    (titleScore < 0.92 || artistScore < 0.85)
  ) {
    rejectionReasons.push('missing duration requires excellent title and artist');
  }
  if (finalScore < MIN_MATCH_SCORE) {
    rejectionReasons.push('final score is below the confidence threshold');
  }

  return {
    candidate,
    titleScore,
    artistScore,
    durationScore: duration.score,
    versionPenalty,
    finalScore,
    targetVersions: target.versions,
    candidateVersions: candidateIdentity.versions,
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

export function chooseSoundCloudCandidate(
  track: Track,
  candidates: readonly SoundCloudCandidate[],
): MatchDecision {
  const scored = candidates
    .map((candidate, index) => ({ score: scoreSoundCloudCandidate(track, candidate), index }))
    .sort(
      (left, right) => right.score.finalScore - left.score.finalScore || left.index - right.index,
    )
    .map(({ score }) => score);

  const best = scored[0];
  if (best === undefined) {
    return { accepted: false, scored, reason: 'no-candidates' };
  }
  if (!best.eligible) {
    return { accepted: false, scored, reason: 'below-threshold' };
  }

  const second = scored[1];
  if (second !== undefined && best.finalScore - second.finalScore < MIN_WINNER_MARGIN) {
    return { accepted: false, scored, reason: 'ambiguous' };
  }
  return {
    accepted: true,
    selected: best.candidate,
    score: best,
    scored,
    reason: 'confident-match',
  };
}

export function buildSoundCloudSearchQuery(track: Track): string {
  const prepared = prepareIdentity(track.title, track.artist);
  return [prepared.artist, prepared.title]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

function prepareIdentity(title: string, artist: string | undefined): PreparedIdentity {
  const versions = extractVersionTags(title);
  const cleanedArtist = artist === undefined ? undefined : normalizeArtist(artist);
  const split = splitArtistAndTitle(title);
  const inferredArtist =
    cleanedArtist ?? (split === undefined ? undefined : normalizeArtist(split.artist));
  let songTitle = split?.title ?? title;
  if (
    split !== undefined &&
    cleanedArtist !== undefined &&
    musicTextSimilarity(split.artist, cleanedArtist) < 0.65
  ) {
    songTitle = title;
  }

  return {
    title: normalizeTitle(songTitle),
    artist: inferredArtist === '' ? undefined : inferredArtist,
    versions,
  };
}

function normalizeTitle(value: string): string {
  const withoutDecorativeBrackets = value.replace(
    /\(([^)]+)\)|\[([^]]+)]/g,
    (whole, roundContent: string | undefined, squareContent: string | undefined) =>
      isDecorativeNoise(roundContent ?? squareContent ?? '') ? ' ' : whole,
  );
  return normalizeMusicText(withoutDecorativeBrackets)
    .replace(
      /\b(?:official music video|official video|official audio|music video|lyric video|lyrics?|visualizer|hd|4k|cc by)\b/g,
      ' ',
    )
    .replace(/\baudio\b$/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeArtist(value: string): string {
  return normalizeMusicText(value)
    .replace(/\b(?:official|vevo|topic)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function splitArtistAndTitle(value: string): { artist: string; title: string } | undefined {
  const parts = value.split(/\s+(?:-|–|—|\||:)\s+/).map((part) => part.trim());
  const artist = parts[0];
  const title = parts.slice(1).join(' - ');
  return parts.length >= 2 && artist !== undefined && artist !== '' && title !== ''
    ? { artist, title }
    : undefined;
}

function isDecorativeNoise(value: string): boolean {
  return /^(?:official(?: music)? video|official audio|music video|lyric video|lyrics?|visualizer|audio|hd|4k|cc[- ]?by)$/i.test(
    value.trim(),
  );
}

function scoreArtist(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) {
    return 0.45;
  }
  return musicTextSimilarity(left, right);
}

function scoreDuration(
  targetMs: number | undefined,
  candidateMs: number | undefined,
): { score: number; hardMismatch: boolean } {
  if (targetMs === undefined || candidateMs === undefined) {
    return { score: 0.5, hardMismatch: false };
  }
  const difference = Math.abs(targetMs - candidateMs);
  const longest = Math.max(targetMs, candidateMs);
  const ratio = difference / longest;
  if (difference <= 3_000) return { score: 1, hardMismatch: false };
  if (difference <= 6_000) return { score: 0.9, hardMismatch: false };
  if (difference <= 10_000 && ratio <= 0.05) return { score: 0.75, hardMismatch: false };
  if (difference <= 10_000 || ratio <= 0.05) return { score: 0.6, hardMismatch: false };
  return { score: 0, hardMismatch: difference > 12_000 && ratio > 0.06 };
}

function symmetricDifference(
  left: readonly VersionTag[],
  right: readonly VersionTag[],
): VersionTag[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [...leftSet, ...rightSet].filter((tag) => leftSet.has(tag) !== rightSet.has(tag));
}

function diceCoefficient<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) {
    if (right.has(value)) overlap += 1;
  }
  return (2 * overlap) / (left.size + right.size);
}

function characterBigrams(value: string): Set<string> {
  const compact = value.replaceAll(' ', '');
  if (compact.length < 2) return new Set([compact]);
  const result = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    result.add(compact.slice(index, index + 2));
  }
  return result;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

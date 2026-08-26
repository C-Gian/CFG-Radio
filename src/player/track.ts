import { randomUUID } from 'node:crypto';

/**
 * Where a track comes from.
 *
 * `soundcloud` will be added by a later milestone without touching the queue
 * or the player.
 */
export type TrackSource = 'local' | 'youtube';

/**
 * The logical identity of something to play.
 *
 * Deliberately free of Discord objects, voice connections, audio resources and
 * file paths: a `Track` survives independently of how (or whether) it is
 * currently being streamed. Turning a track into something FFmpeg can read is
 * the resolver's job, not the queue's.
 */
export interface Track {
  /** Unique per enqueue - the same song added twice yields two tracks. */
  readonly id: string;
  readonly title: string;
  /** Known duration, or `undefined` for sources that cannot tell yet. */
  readonly durationMs: number | undefined;
  readonly source: TrackSource;
  /** Stable id of the item inside its source (catalog key, video id, ...). */
  readonly sourceId: string;
  /** What the user actually asked for, kept for logs and future re-resolution. */
  readonly originalInput: string;
  readonly requestedByUserId: string;
  readonly requestedAt: Date;
  /** Uploader / channel / artist, when the source exposes one. */
  readonly artist: string | undefined;
  /** Stable page the track came from - never a signed media URL. */
  readonly canonicalUrl: string | undefined;
  readonly thumbnailUrl: string | undefined;
}

export interface CreateTrackInput {
  readonly title: string;
  readonly source: TrackSource;
  readonly sourceId: string;
  readonly originalInput: string;
  readonly requestedByUserId: string;
  readonly durationMs?: number | undefined;
  readonly artist?: string | undefined;
  readonly canonicalUrl?: string | undefined;
  readonly thumbnailUrl?: string | undefined;
}

/** Builds a track with a fresh id and request timestamp. */
export function createTrack(input: CreateTrackInput): Track {
  return {
    id: randomUUID(),
    title: input.title,
    durationMs: input.durationMs,
    source: input.source,
    sourceId: input.sourceId,
    originalInput: input.originalInput,
    requestedByUserId: input.requestedByUserId,
    requestedAt: new Date(),
    artist: input.artist,
    canonicalUrl: input.canonicalUrl,
    thumbnailUrl: input.thumbnailUrl,
  };
}

/** Compact identification used in log lines. */
export function describeTrack(track: Track): string {
  return `${track.source}:${track.sourceId} "${track.title}" (${track.id})`;
}

import { vi } from 'vitest';

import type { PlayableSource, PlaybackTransport } from '../../src/player/transport.js';
import { createTrack, type Track } from '../../src/player/track.js';

/**
 * A playback transport with no Discord, no voice connection and no FFmpeg.
 *
 * Tests drive it explicitly: `finishTrack()` simulates a track ending on its
 * own, `breakPlayback()` an audio failure, and `failFor()` makes `play()`
 * reject for a given source.
 */
export class FakeTransport implements PlaybackTransport {
  readonly played: PlayableSource[] = [];
  readonly playedVolumes: number[] = [];
  stopCount = 0;
  paused = false;
  volume = 1;
  readonly volumeChanges: number[] = [];

  private readonly failing = new Set<string>();
  private trackEndListener: (() => void) | undefined;
  private playbackErrorListener: ((error: unknown) => void) | undefined;
  private pauseSucceeds = true;
  private resumeSucceeds = true;
  private endOnStop = false;

  /** Makes `play()` reject for the source whose input matches `input`. */
  failFor(...inputs: string[]): void {
    for (const input of inputs) {
      this.failing.add(input);
    }
  }

  setPauseSucceeds(value: boolean): void {
    this.pauseSucceeds = value;
  }

  setResumeSucceeds(value: boolean): void {
    this.resumeSucceeds = value;
  }

  get lastPlayed(): PlayableSource | undefined {
    return this.played.at(-1);
  }

  play(source: PlayableSource): Promise<void> {
    if (this.failing.has(source.input)) {
      return Promise.reject(new Error(`cannot play ${source.input}`));
    }
    this.played.push(source);
    this.playedVolumes.push(this.volume);
    this.paused = false;
    return Promise.resolve();
  }

  pause(): boolean {
    if (!this.pauseSucceeds) {
      return false;
    }
    this.paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.resumeSucceeds) {
      return false;
    }
    this.paused = false;
    return true;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    this.volumeChanges.push(volume);
  }

  /**
   * Makes `stopPlayback()` emit a track end, the way a transport that does not
   * suppress its own Idle transition would. The player must treat it as stale.
   */
  emitTrackEndOnStop(value: boolean): void {
    this.endOnStop = value;
  }

  stopPlayback(): void {
    this.stopCount += 1;
    this.paused = false;
    if (this.endOnStop) {
      this.trackEndListener?.();
    }
  }

  onTrackEnd(listener: () => void): void {
    this.trackEndListener = listener;
  }

  onPlaybackError(listener: (error: unknown) => void): void {
    this.playbackErrorListener = listener;
  }

  /** Simulates the current track reaching its end. */
  finishTrack(): void {
    this.trackEndListener?.();
  }

  /** Simulates the audio player breaking mid-track. */
  breakPlayback(error: unknown = new Error('audio player exploded')): void {
    this.playbackErrorListener?.(error);
  }
}

export function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/** A local track whose resolved input is `<sourceId>.opus`. */
export function localTrack(sourceId: string, requestedByUserId = 'user-1'): Track {
  return createTrack({
    title: `Track ${sourceId}`,
    source: 'local',
    sourceId,
    originalInput: sourceId,
    requestedByUserId,
    durationMs: 8000,
  });
}

/** Resolver matching {@link localTrack}: no filesystem access involved. */
export function fakeResolver(track: Track): PlayableSource {
  return { kind: 'file', input: `${track.sourceId}.opus` };
}

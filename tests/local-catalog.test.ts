import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_ASSET_ID,
  LOCAL_ASSETS,
  findLocalAsset,
  localAssetPath,
  resolveLocalTrack,
} from '../src/audio/local-catalog.js';
import { createTrack, describeTrack, type Track } from '../src/player/track.js';

function localTrack(sourceId: string): Track {
  return createTrack({
    title: 'whatever',
    source: 'local',
    sourceId,
    originalInput: sourceId,
    requestedByUserId: 'user-1',
  });
}

describe('local catalog', () => {
  it('ships three distinguishable assets', () => {
    expect(LOCAL_ASSETS.map((asset) => asset.id)).toEqual(['arpeggio', 'ascending', 'descending']);
  });

  it('derives file names and durations from the recipe', () => {
    for (const asset of LOCAL_ASSETS) {
      expect(asset.fileName).toBe(`${asset.id}.opus`);
      expect(asset.durationMs).toBe(Math.round(asset.notes.length * asset.noteSeconds * 1000));
      expect(asset.durationMs).toBeGreaterThanOrEqual(5000);
      expect(asset.durationMs).toBeLessThanOrEqual(10_000);
      expect(asset.title).not.toBe('');
    }
  });

  it('has a default asset that exists', () => {
    expect(findLocalAsset(DEFAULT_LOCAL_ASSET_ID)).toBeDefined();
  });

  it('returns undefined for an unknown id', () => {
    expect(findLocalAsset('nope')).toBeUndefined();
  });

  it('resolves every asset path inside assets/', () => {
    for (const asset of LOCAL_ASSETS) {
      expect(localAssetPath(asset).replaceAll('\\', '/')).toMatch(
        new RegExp(`/assets/${asset.id}\\.opus$`),
      );
    }
  });
});

describe('resolveLocalTrack', () => {
  it('resolves a catalog track to a readable file', async () => {
    const source = await resolveLocalTrack(localTrack('ascending'));

    expect(source.kind).toBe('file');
    expect(source.input.replaceAll('\\', '/')).toMatch(/\/assets\/ascending\.opus$/);
  });

  it('rejects an unknown asset id', async () => {
    await expect(resolveLocalTrack(localTrack('missing'))).rejects.toThrow(/Unknown local asset/);
  });
});

describe('Track', () => {
  it('gives every track a unique id and a request timestamp', () => {
    const first = localTrack('arpeggio');
    const second = localTrack('arpeggio');

    expect(first.id).not.toBe(second.id);
    expect(first.requestedAt).toBeInstanceOf(Date);
    expect(first.source).toBe('local');
    expect(first.sourceId).toBe('arpeggio');
  });

  it('carries no playback details', () => {
    const track = localTrack('arpeggio');

    expect(Object.keys(track).sort()).toEqual([
      'durationMs',
      'id',
      'originalInput',
      'requestedAt',
      'requestedByUserId',
      'source',
      'sourceId',
      'title',
    ]);
  });

  it('describes itself for the logs', () => {
    const track = localTrack('arpeggio');

    expect(describeTrack(track)).toContain('local:arpeggio');
    expect(describeTrack(track)).toContain(track.id);
  });
});

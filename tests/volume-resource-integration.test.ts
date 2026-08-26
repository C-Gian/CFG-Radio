import { createReadStream } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_ASSETS, localAssetPath } from '../src/audio/local-catalog.js';
import { createVolumeResource } from '../src/voice/volume-resource.js';

describe('real inline-volume audio resource', () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it('applies 0%, 50% and 100%, re-encodes Opus and cleans up', async () => {
    const asset = LOCAL_ASSETS[0];
    if (asset === undefined) {
      throw new Error('Expected the bundled arpeggio asset');
    }
    const input = createReadStream(localAssetPath(asset));
    const resource = createVolumeResource(input, 0);
    cleanups.push(() => {
      resource.playStream.destroy();
      input.destroy();
    });

    expect(resource.volume?.volume).toBe(0);
    resource.volume?.setVolume(0.5);
    expect(resource.volume?.volume).toBe(0.5);
    resource.volume?.setVolume(1);
    expect(resource.volume?.volume).toBe(1);

    const packet = await new Promise<Buffer>((resolve, reject) => {
      resource.playStream.once('data', resolve);
      resource.playStream.once('error', reject);
    });
    expect(packet.byteLength).toBeGreaterThan(0);

    resource.playStream.destroy();
    input.destroy();
    expect(resource.playStream.destroyed).toBe(true);
    expect(input.destroyed).toBe(true);
  });
});

import { StreamType, createAudioResource, type AudioResource } from '@discordjs/voice';
import type { Readable } from 'node:stream';

/**
 * Creates the Ogg/Opus resource used by voice playback with a live PCM volume
 * stage. @discordjs/voice demuxes and decodes Opus, changes gain, then encodes
 * it again; opusscript supplies that supported codec path.
 */
export function createVolumeResource(input: Readable, initialVolume: number): AudioResource<null> {
  assertVolumeScalar(initialVolume);
  const resource = createAudioResource(input, {
    inputType: StreamType.OggOpus,
    inlineVolume: true,
  });
  if (resource.volume === undefined) {
    resource.playStream.destroy();
    throw new Error('Discord voice did not create the requested inline volume stage');
  }
  resource.volume.setVolume(initialVolume);
  return resource;
}

export function assertVolumeScalar(volume: number): void {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new RangeError('Playback volume must be between 0 and 1');
  }
}

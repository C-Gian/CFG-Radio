import { describe, expect, it, vi } from 'vitest';

import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { VoiceSessionManager } from '../src/voice/session-manager.js';
import type { VoiceSessionHandle, VoiceSessionOptions } from '../src/voice/session.js';

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

const adapterCreator = (() => ({})) as unknown as DiscordGatewayAdapterCreator;

class FakeSession implements VoiceSessionHandle {
  readonly guildId: string;
  channelId: string | null;
  isPlaying = false;
  destroyCount = 0;
  readonly played: string[] = [];

  private readonly onDestroyed: ((guildId: string) => void) | undefined;

  constructor(options: VoiceSessionOptions) {
    this.guildId = options.guildId;
    this.channelId = options.channelId;
    this.onDestroyed = options.onDestroyed;
  }

  play(filePath: string): Promise<void> {
    this.played.push(filePath);
    this.isPlaying = true;
    return Promise.resolve();
  }

  stopPlayback(): void {
    this.isPlaying = false;
  }

  destroy(): void {
    this.destroyCount += 1;
    this.stopPlayback();
    this.onDestroyed?.(this.guildId);
  }
}

function createManager() {
  const created: FakeSession[] = [];
  const manager = new VoiceSessionManager({
    ffmpegPath: 'ffmpeg',
    logger: fakeLogger(),
    createSession: (options) => {
      const session = new FakeSession(options);
      created.push(session);
      return Promise.resolve(session);
    },
  });
  return { manager, created };
}

const request = { guildId: 'guild-1', channelId: 'channel-1', adapterCreator };

describe('VoiceSessionManager', () => {
  it('creates one session per guild and hands the FFmpeg path down', async () => {
    const { manager, created } = createManager();

    const session = await manager.join(request);

    expect(manager.get('guild-1')).toBe(session);
    expect(manager.size).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('reuses the existing session instead of joining twice', async () => {
    const { manager, created } = createManager();

    const first = await manager.join(request);
    const second = await manager.join({ ...request, channelId: 'channel-2' });

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    // Never silently moved to the other channel.
    expect(second.channelId).toBe('channel-1');
  });

  it('keeps guilds isolated', async () => {
    const { manager } = createManager();

    const first = await manager.join(request);
    const second = await manager.join({ ...request, guildId: 'guild-2' });

    expect(second).not.toBe(first);
    expect(manager.size).toBe(2);
  });

  it('destroys a session and forgets it', async () => {
    const { manager } = createManager();
    const session = (await manager.join(request)) as FakeSession;

    expect(manager.destroy('guild-1')).toBe(true);
    expect(session.destroyCount).toBe(1);
    expect(manager.get('guild-1')).toBeUndefined();
    expect(manager.size).toBe(0);
  });

  it('is idempotent: destroying twice is safe and reports no second session', async () => {
    const { manager } = createManager();
    const session = (await manager.join(request)) as FakeSession;

    manager.destroy('guild-1');

    expect(manager.destroy('guild-1')).toBe(false);
    expect(session.destroyCount).toBe(1);
  });

  it('reports nothing to do for an unknown guild', () => {
    const { manager } = createManager();

    expect(manager.destroy('guild-unknown')).toBe(false);
  });

  it('drops the session when it tears itself down (kick, disconnect)', async () => {
    const { manager } = createManager();
    const session = (await manager.join(request)) as FakeSession;

    session.destroy();

    expect(manager.get('guild-1')).toBeUndefined();
    expect(manager.size).toBe(0);
  });

  it('destroys every session on shutdown', async () => {
    const { manager, created } = createManager();
    await manager.join(request);
    await manager.join({ ...request, guildId: 'guild-2' });

    manager.destroyAll();

    expect(manager.size).toBe(0);
    expect(created.map((session) => session.destroyCount)).toEqual([1, 1]);
  });

  it('survives destroyAll being called twice', async () => {
    const { manager, created } = createManager();
    await manager.join(request);

    manager.destroyAll();
    manager.destroyAll();

    expect(created[0]?.destroyCount).toBe(1);
  });
});

import { vi } from 'vitest';

import type { AppConfig } from '../../src/config/env.js';
import type { CommandContext } from '../../src/discord/context.js';
import type { VoiceSessionManager } from '../../src/voice/session-manager.js';

export function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

export const fakeConfig: AppConfig = {
  discordToken: 'not-a-real-token',
  discordClientId: '111111111111111111',
  discordGuildId: '222222222222222222',
  logLevel: 'info',
  defaultVolume: 100,
  idleDisconnectSeconds: 300,
  ffmpegPath: 'ffmpeg',
};

export interface FakeVoiceManager {
  get: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyAll: ReturnType<typeof vi.fn>;
}

/** A command context wired to spies - no Discord, no voice, no FFmpeg. */
export function fakeContext(voiceOverrides: Partial<FakeVoiceManager> = {}) {
  const logger = fakeLogger();
  const voice: FakeVoiceManager = {
    get: vi.fn().mockReturnValue(undefined),
    join: vi.fn(),
    destroy: vi.fn().mockReturnValue(false),
    destroyAll: vi.fn(),
    ...voiceOverrides,
  };

  const context: CommandContext = {
    config: fakeConfig,
    logger,
    voice: voice as unknown as VoiceSessionManager,
  };

  return { context, logger, voice };
}

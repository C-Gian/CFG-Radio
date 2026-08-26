import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';

import { VoiceSession, type VoiceSessionHandle, type VoiceSessionOptions } from './session.js';
import type { Logger } from '../logger.js';

export interface JoinRequest {
  readonly guildId: string;
  readonly channelId: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
}

export type VoiceSessionFactory = (options: VoiceSessionOptions) => Promise<VoiceSessionHandle>;

export interface VoiceSessionManagerOptions {
  readonly ffmpegPath: string;
  readonly logger: Logger;
  /** Injected in tests; defaults to a real `VoiceSession`. */
  readonly createSession?: VoiceSessionFactory;
}

/**
 * Owns one voice session per guild.
 *
 * CFG Radio is single-guild today, but keying by guild id costs nothing and
 * keeps the guild id out of the playback logic.
 */
export class VoiceSessionManager {
  private readonly sessions = new Map<string, VoiceSessionHandle>();
  private readonly ffmpegPath: string;
  private readonly logger: Logger;
  private readonly createSession: VoiceSessionFactory;
  private readonly destroyedListeners: ((guildId: string) => void)[] = [];

  constructor(options: VoiceSessionManagerOptions) {
    this.ffmpegPath = options.ffmpegPath;
    this.logger = options.logger;
    this.createSession = options.createSession ?? ((opts) => VoiceSession.create(opts));
  }

  /**
   * Registers a listener called whenever a session goes away - including when
   * it tears itself down after a kick or a lost connection.
   */
  onSessionDestroyed(listener: (guildId: string) => void): void {
    this.destroyedListeners.push(listener);
  }

  get(guildId: string): VoiceSessionHandle | undefined {
    return this.sessions.get(guildId);
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Returns the existing session for the guild, or joins `channelId`.
   *
   * Callers are responsible for the "already connected elsewhere" policy: this
   * method never moves an existing session to another channel.
   */
  async join(request: JoinRequest): Promise<VoiceSessionHandle> {
    const existing = this.sessions.get(request.guildId);
    if (existing !== undefined) {
      return existing;
    }

    const session = await this.createSession({
      guildId: request.guildId,
      channelId: request.channelId,
      adapterCreator: request.adapterCreator,
      ffmpegPath: this.ffmpegPath,
      logger: this.logger,
      onDestroyed: (guildId) => {
        this.sessions.delete(guildId);
        for (const listener of this.destroyedListeners) {
          listener(guildId);
        }
      },
    });

    this.sessions.set(request.guildId, session);
    return session;
  }

  /**
   * Destroys the guild session if there is one.
   *
   * @returns `true` when a session was actually torn down.
   */
  destroy(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (session === undefined) {
      return false;
    }
    // `destroy()` calls back into `onDestroyed`, but deleting twice is a no-op.
    this.sessions.delete(guildId);
    session.destroy();
    return true;
  }

  /** Tears every session down. Used by the graceful shutdown path. */
  destroyAll(): void {
    for (const guildId of [...this.sessions.keys()]) {
      this.destroy(guildId);
    }
  }
}

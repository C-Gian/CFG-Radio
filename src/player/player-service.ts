import { GuildPlayer } from './guild-player.js';
import type { TrackResolver } from './transport.js';
import type { Logger } from '../logger.js';
import type { JoinRequest, VoiceSessionManager } from '../voice/session-manager.js';

export interface PlayerServiceOptions {
  readonly voice: VoiceSessionManager;
  readonly resolve: TrackResolver;
  readonly logger: Logger;
}

/**
 * Ties one `GuildPlayer` to one voice session.
 *
 * The voice manager owns the transport (connection, audio player, FFmpeg);
 * this service owns the orchestration on top of it and makes sure the two are
 * created and destroyed together.
 */
export class PlayerService {
  private readonly players = new Map<string, GuildPlayer>();
  private readonly voice: VoiceSessionManager;
  private readonly resolve: TrackResolver;
  private readonly logger: Logger;

  constructor(options: PlayerServiceOptions) {
    this.voice = options.voice;
    this.resolve = options.resolve;
    this.logger = options.logger;

    // A session can disappear on its own (kick, lost connection): the player
    // must not survive its transport.
    this.voice.onSessionDestroyed((guildId) => {
      const player = this.players.get(guildId);
      this.players.delete(guildId);
      player?.destroy();
    });
  }

  /** The player of a guild, if the bot is connected there. */
  get(guildId: string): GuildPlayer | undefined {
    return this.players.get(guildId);
  }

  /** The voice channel the bot is connected to in this guild, if any. */
  channelIdOf(guildId: string): string | null | undefined {
    return this.voice.get(guildId)?.channelId;
  }

  /**
   * Returns the guild player, joining the voice channel if needed.
   *
   * Never moves an existing connection: the caller applies that policy first.
   */
  async join(request: JoinRequest): Promise<GuildPlayer> {
    const existing = this.players.get(request.guildId);
    if (existing !== undefined) {
      return existing;
    }

    const session = await this.voice.join(request);
    const player = new GuildPlayer({
      guildId: request.guildId,
      transport: session,
      resolve: this.resolve,
      logger: this.logger,
    });

    this.players.set(request.guildId, player);
    return player;
  }

  /**
   * Stops the player and destroys the voice session of a guild.
   *
   * @returns `true` when there was something to tear down.
   */
  destroy(guildId: string): boolean {
    const player = this.players.get(guildId);
    this.players.delete(guildId);
    player?.destroy();
    const hadSession = this.voice.destroy(guildId);
    return player !== undefined || hadSession;
  }

  /** Tears every guild down. Used by the graceful shutdown path. */
  destroyAll(): void {
    for (const guildId of [...this.players.keys()]) {
      this.destroy(guildId);
    }
    // Any session without a player (join succeeded, player never created).
    this.voice.destroyAll();
    this.logger.debug('All guild players destroyed');
  }
}

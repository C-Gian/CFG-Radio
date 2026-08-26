import { GuildPlayer } from './guild-player.js';
import type { PlaybackFallbackResolver, TrackResolver } from './transport.js';
import type { Logger } from '../logger.js';
import type { JoinRequest, VoiceSessionManager } from '../voice/session-manager.js';

export interface PlayerServiceOptions {
  readonly voice: VoiceSessionManager;
  readonly resolve: TrackResolver;
  readonly resolveFallback?: PlaybackFallbackResolver;
  readonly logger: Logger;
  readonly defaultVolume?: number;
  readonly idleDisconnectSeconds?: number;
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
  private readonly resolveFallback: PlaybackFallbackResolver | undefined;
  private readonly logger: Logger;
  private readonly defaultVolume: number;
  private readonly idleDisconnectSeconds: number;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleEpochs = new Map<string, number>();
  /** In-flight joins, so simultaneous commands share one voice handshake. */
  private readonly pendingJoins = new Map<string, Promise<GuildPlayer>>();
  /** Bumped by every teardown, so a join that lost the race cannot install itself. */
  private readonly joinEpochs = new Map<string, number>();

  constructor(options: PlayerServiceOptions) {
    this.voice = options.voice;
    this.resolve = options.resolve;
    this.resolveFallback = options.resolveFallback;
    this.logger = options.logger;
    this.defaultVolume = options.defaultVolume ?? 100;
    this.idleDisconnectSeconds = options.idleDisconnectSeconds ?? 300;

    // A session can disappear on its own (kick, lost connection): the player
    // must not survive its transport.
    this.voice.onSessionDestroyed((guildId) => {
      this.cancelIdleTimer(guildId);
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

    // Two /play commands can land while the first handshake is still running:
    // without this they would each build a session and a player, and the
    // loser would be silently orphaned but still subscribed to its transport.
    const pending = this.pendingJoins.get(request.guildId);
    if (pending !== undefined) {
      return pending;
    }

    const attempt = this.createPlayer(request);
    this.pendingJoins.set(request.guildId, attempt);
    try {
      return await attempt;
    } finally {
      this.pendingJoins.delete(request.guildId);
    }
  }

  private async createPlayer(request: JoinRequest): Promise<GuildPlayer> {
    const epoch = this.joinEpochs.get(request.guildId) ?? 0;
    const session = await this.voice.join(request);

    if ((this.joinEpochs.get(request.guildId) ?? 0) !== epoch) {
      // A /disconnect or a shutdown won the race: leaving the fresh session
      // installed would keep the bot in the channel it was just told to leave.
      this.voice.destroy(request.guildId);
      throw new Error('The voice session was disconnected while joining');
    }

    const player = new GuildPlayer({
      guildId: request.guildId,
      transport: session,
      resolve: this.resolve,
      ...(this.resolveFallback === undefined ? {} : { resolveFallback: this.resolveFallback }),
      logger: this.logger,
      defaultVolume: this.defaultVolume,
      onIdleChange: (idle) => {
        this.updateIdleTimer(request.guildId, idle);
      },
    });

    this.players.set(request.guildId, player);
    this.updateIdleTimer(request.guildId, player.isIdle);
    return player;
  }

  /**
   * Stops the player and destroys the voice session of a guild.
   *
   * @returns `true` when there was something to tear down.
   */
  destroy(guildId: string): boolean {
    this.joinEpochs.set(guildId, (this.joinEpochs.get(guildId) ?? 0) + 1);
    this.cancelIdleTimer(guildId);
    const player = this.players.get(guildId);
    this.players.delete(guildId);
    player?.destroy();
    const hadSession = this.voice.destroy(guildId);
    return player !== undefined || hadSession;
  }

  /** Tears every guild down. Used by the graceful shutdown path. */
  destroyAll(): void {
    // Pending joins included: a handshake that finishes after shutdown must
    // not resurrect a guild.
    for (const guildId of new Set([...this.players.keys(), ...this.pendingJoins.keys()])) {
      this.destroy(guildId);
    }
    // Any session without a player (join succeeded, player never created).
    this.voice.destroyAll();
    this.logger.debug('All guild players destroyed');
  }

  private updateIdleTimer(guildId: string, idle: boolean): void {
    if (!idle) {
      this.cancelIdleTimer(guildId);
      return;
    }
    if (this.idleDisconnectSeconds === 0 || this.idleTimers.has(guildId)) {
      return;
    }
    const player = this.players.get(guildId);
    if (player === undefined) {
      return;
    }

    const epoch = (this.idleEpochs.get(guildId) ?? 0) + 1;
    this.idleEpochs.set(guildId, epoch);
    const delayMs = this.idleDisconnectSeconds * 1000;
    const timer = setTimeout(() => {
      if (
        this.idleEpochs.get(guildId) !== epoch ||
        this.players.get(guildId) !== player ||
        !player.isIdle
      ) {
        return;
      }
      this.idleTimers.delete(guildId);
      this.logger.info(`Idle disconnect in guild ${guildId} after ${this.idleDisconnectSeconds}s`);
      this.destroy(guildId);
    }, delayMs);
    this.idleTimers.set(guildId, timer);
    this.logger.debug(`Idle timer scheduled in guild ${guildId}: ${this.idleDisconnectSeconds}s`);
  }

  private cancelIdleTimer(guildId: string): void {
    const timer = this.idleTimers.get(guildId);
    this.idleEpochs.set(guildId, (this.idleEpochs.get(guildId) ?? 0) + 1);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.idleTimers.delete(guildId);
    this.logger.debug(`Idle timer cancelled in guild ${guildId}`);
  }
}

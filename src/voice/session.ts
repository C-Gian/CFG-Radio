import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
  type AudioResource,
} from '@discordjs/voice';

import { FfmpegPipeline } from '../audio/ffmpeg.js';
import type { PlayableSource, PlaybackTransport } from '../player/transport.js';
import type { Logger } from '../logger.js';
import { assertVolumeScalar, createVolumeResource } from './volume-resource.js';

/** How long the gateway handshake may take before we give up and clean up. */
export const CONNECTION_READY_TIMEOUT_MS = 15_000;
/** How long FFmpeg has to produce the first audio frames. */
export const PLAYBACK_START_TIMEOUT_MS = 10_000;
/** Grace period given to a `Disconnected` connection to come back on its own. */
const RECONNECT_GRACE_MS = 5_000;

export interface VoiceSessionOptions {
  readonly guildId: string;
  readonly channelId: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly ffmpegPath: string;
  readonly logger: Logger;
  /** Called once when the session tears itself down (kick, disconnect, ...). */
  readonly onDestroyed?: (guildId: string) => void;
}

/**
 * The surface the commands and the session manager depend on.
 *
 * Declaring it explicitly keeps their tests free of discord.js voice internals.
 */
export interface VoiceSessionHandle extends PlaybackTransport {
  readonly guildId: string;
  readonly channelId: string | null;
  destroy(): void;
}

/**
 * Everything CFG Radio owns inside one guild: the voice connection, the audio
 * player and the FFmpeg process currently feeding it.
 *
 * There is no queue yet - a session plays at most one file at a time, and
 * `destroy()` is idempotent so the shutdown path can always call it.
 */
export class VoiceSession implements VoiceSessionHandle {
  readonly guildId: string;

  private readonly connection: VoiceConnection;
  private readonly player: AudioPlayer;
  private readonly logger: Logger;
  private readonly ffmpegPath: string;
  private readonly onDestroyed: ((guildId: string) => void) | undefined;

  private pipeline: FfmpegPipeline | undefined;
  private resource: AudioResource<null> | undefined;
  private volume = 1;
  private destroyed = false;
  /** Set while we stop playback ourselves, so the Idle that follows is not a track end. */
  private stoppingOnPurpose = false;
  private trackEndListener: (() => void) | undefined;
  private playbackErrorListener: ((error: unknown) => void) | undefined;

  private constructor(connection: VoiceConnection, options: VoiceSessionOptions) {
    this.guildId = options.guildId;
    this.connection = connection;
    this.logger = options.logger;
    this.ffmpegPath = options.ffmpegPath;
    this.onDestroyed = options.onDestroyed;

    this.player = createAudioPlayer({
      behaviors: {
        // Nobody listening is not a reason to keep burning CPU on FFmpeg.
        noSubscriber: NoSubscriberBehavior.Pause,
      },
    });

    this.attachPlayerListeners();
    this.attachConnectionListeners();
    this.connection.subscribe(this.player);
  }

  /**
   * Joins `channelId` and waits for the connection to be ready.
   *
   * On timeout (or any failure) the half-open connection is destroyed before
   * the error is propagated, so no dangling connection is ever left behind.
   */
  static async create(options: VoiceSessionOptions): Promise<VoiceSession> {
    const connection = joinVoiceChannel({
      guildId: options.guildId,
      channelId: options.channelId,
      adapterCreator: options.adapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    let session: VoiceSession;
    try {
      session = new VoiceSession(connection, options);
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_READY_TIMEOUT_MS);
    } catch (error) {
      connection.destroy();
      throw new Error(
        `Could not join the voice channel within ${CONNECTION_READY_TIMEOUT_MS / 1000}s`,
        { cause: error },
      );
    }

    options.logger.info(`Voice connection ready in guild ${options.guildId}`);
    return session;
  }

  /** The channel the connection is currently bound to. */
  get channelId(): string | null {
    return this.connection.joinConfig.channelId;
  }

  /** Registers the listener notified when a track ends on its own. */
  onTrackEnd(listener: () => void): void {
    this.trackEndListener = listener;
  }

  /** Registers the listener notified when playback breaks unexpectedly. */
  onPlaybackError(listener: (error: unknown) => void): void {
    this.playbackErrorListener = listener;
  }

  /**
   * Plays a source through a fresh FFmpeg pipeline.
   *
   * Any previous playback is torn down first, and the call only resolves once
   * audio is actually flowing - a broken FFmpeg therefore surfaces as an error
   * the caller can report to the user.
   */
  async play(source: PlayableSource): Promise<void> {
    this.assertAlive();
    this.stopPlayback();

    const pipeline = FfmpegPipeline.start({
      ffmpegPath: this.ffmpegPath,
      inputPath: source.input,
      inputOptions: { headers: source.headers, remote: source.kind === 'url' },
      logger: this.logger,
      onUnexpectedExit: (reason) => {
        this.logger.error(`Playback pipeline stopped unexpectedly: ${reason}`);
        this.failPlayback(new Error(reason));
      },
    });
    this.pipeline = pipeline;

    try {
      const resource = createVolumeResource(pipeline.output, this.volume);
      this.resource = resource;
      this.player.play(resource);
      await entersState(this.player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT_MS);
      this.logger.info(`Playback started in guild ${this.guildId}`);
    } catch (error) {
      this.stopPlayback();
      throw new Error('Playback did not start (FFmpeg produced no audio in time)', {
        cause: error,
      });
    }
  }

  /** Pauses the audio player, keeping the FFmpeg pipeline alive. */
  pause(): boolean {
    return this.player.pause(true);
  }

  resume(): boolean {
    return this.player.unpause();
  }

  /** Changes gain immediately without restarting or re-resolving the track. */
  setVolume(volume: number): void {
    assertVolumeScalar(volume);
    this.volume = volume;
    this.resource?.volume?.setVolume(volume);
  }

  /**
   * Stops the player and kills the current FFmpeg process. Idempotent.
   *
   * The resulting `Idle` transition is flagged as deliberate, so the
   * orchestration layer never mistakes a stop or a skip for a track that
   * finished on its own.
   */
  stopPlayback(): void {
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.stoppingOnPurpose = true;
      this.player.stop(true);
      this.stoppingOnPurpose = false;
    }
    this.pipeline?.stop();
    this.pipeline = undefined;
    this.resource?.playStream.destroy();
    this.resource = undefined;
  }

  /** Stops playback and destroys the voice connection. Idempotent. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.stopPlayback();
    try {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
    } catch (error) {
      this.logger.warn('Failed to destroy the voice connection cleanly', error);
    }

    this.logger.info(`Voice session closed in guild ${this.guildId}`);
    this.onDestroyed?.(this.guildId);
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('This voice session has already been destroyed');
    }
  }

  private attachPlayerListeners(): void {
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Release FFmpeg but keep the connection open: the orchestration layer
      // decides whether anything should play next.
      const deliberate = this.stoppingOnPurpose;
      this.pipeline?.stop();
      this.pipeline = undefined;
      this.resource = undefined;

      if (deliberate || this.destroyed) {
        return;
      }
      this.logger.debug(`Track ended in guild ${this.guildId}`);
      this.trackEndListener?.();
    });

    this.player.on('error', (error) => {
      this.logger.error(`Audio player error in guild ${this.guildId}`, error);
      this.failPlayback(error);
    });
  }

  /** Reports a playback failure once, after cleaning the pipeline up. */
  private failPlayback(error: unknown): void {
    if (this.destroyed) {
      return;
    }
    this.stopPlayback();
    this.playbackErrorListener?.(error);
  }

  private attachConnectionListeners(): void {
    this.connection.on(VoiceConnectionStatus.Disconnected, (_oldState, newState) => {
      const movedByDiscord =
        newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
        newState.closeCode === 4014;

      if (movedByDiscord) {
        // Kicked from the channel (or the channel is gone): do not fight it.
        this.logger.info(`Disconnected from voice in guild ${this.guildId}`);
        this.destroy();
        return;
      }

      // Transient drop: give the library a moment to reconnect, then give up.
      void entersState(this.connection, VoiceConnectionStatus.Ready, RECONNECT_GRACE_MS).catch(
        () => {
          this.logger.warn(`Voice connection lost in guild ${this.guildId}, cleaning up`);
          this.destroy();
        },
      );
    });

    this.connection.on('error', (error) => {
      this.logger.error(`Voice connection error in guild ${this.guildId}`, error);
    });
  }
}

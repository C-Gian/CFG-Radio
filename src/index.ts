import 'dotenv/config';

import { ConfigError, loadConfig } from './config/env.js';
import { attachHandlers, createClient } from './discord/client.js';
import { createCommandRegistry } from './discord/command.js';
import { commands } from './discord/commands/index.js';
import { createLogger, formatForLog, registerSecret, type Logger } from './logger.js';
import { createTrackResolver } from './audio/track-resolver.js';
import { PlayerService } from './player/player-service.js';
import { VoiceSessionManager } from './voice/session-manager.js';
import { createYouTubeMetadataProvider } from './youtube/metadata.js';
import { createYouTubePlaylistProvider } from './youtube/playlist.js';
import { YtDlpRunner } from './youtube/ytdlp.js';
import { createSoundCloudFallbackResolver } from './soundcloud/fallback.js';

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * How long the ordinary teardown may take before the process leaves anyway.
 *
 * Cleanup is always the main path; this only stops a wedged library from
 * keeping the bot alive forever after the operator asked it to stop.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

function fail(error: unknown): never {
  if (error instanceof ConfigError) {
    // Printed with console on purpose: the logger may not exist yet.
    console.error(`[FATAL] ${error.message}`);
  } else {
    console.error('[FATAL] Failed to start CFG Radio', formatForLog(error));
  }
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Registered before anything is logged, so it can never surface in the logs.
  registerSecret(config.discordToken);

  const logger = createLogger(config.logLevel);
  const client = createClient();
  const voice = new VoiceSessionManager({ ffmpegPath: config.ffmpegPath, logger });
  const ytdlp = new YtDlpRunner({ ytdlpPath: config.ytdlpPath, logger });
  const players = new PlayerService({
    voice,
    resolve: createTrackResolver({ ytdlp }),
    resolveFallback: createSoundCloudFallbackResolver({ ytdlp, logger }),
    logger,
    defaultVolume: config.defaultVolume,
    idleDisconnectSeconds: config.idleDisconnectSeconds,
  });
  const youtube = {
    ...createYouTubeMetadataProvider(ytdlp),
    ...createYouTubePlaylistProvider(ytdlp),
  };

  attachHandlers(client, createCommandRegistry(commands), { config, logger, players, youtube });
  installProcessHandlers({ client, players, ytdlp, logger });

  logger.info('Starting CFG Radio...');
  logger.debug(
    `Config loaded (logLevel=${config.logLevel}, defaultVolume=${config.defaultVolume}, ` +
      `idleDisconnectSeconds=${config.idleDisconnectSeconds}, ffmpegPath=${config.ffmpegPath}, ` +
      `ytdlpPath=${config.ytdlpPath}, maxPlaylistTracks=${config.maxPlaylistTracks})`,
  );

  await client.login(config.discordToken);
}

interface ShutdownTargets {
  readonly client: { destroy: () => Promise<void> };
  readonly players: { destroyAll: () => void };
  readonly ytdlp: { destroy: () => void };
  readonly logger: Logger;
}

function installProcessHandlers({ client, players, ytdlp, logger }: ShutdownTargets): void {
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Shutdown started (${reason})`);

    // Nothing may keep the process alive past the deadline. The timer does not
    // hold the event loop open, so a clean exit is never delayed by it.
    const watchdog = setTimeout(() => {
      logger.error(
        `Shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms; forcing the process to exit`,
      );
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, SHUTDOWN_DEADLINE_MS);
    watchdog.unref();

    // Players abort their in-flight attempts and stop FFmpeg; the runner then
    // kills whatever extraction is still running; the gateway goes last.
    try {
      players.destroyAll();
    } catch (error) {
      logger.error('Failed to close the voice sessions cleanly', error);
    }
    try {
      ytdlp.destroy();
    } catch (error) {
      logger.error('Failed to stop yt-dlp processes cleanly', error);
    }

    client
      .destroy()
      .then(() => {
        logger.info('Discord client destroyed');
      })
      .catch((error: unknown) => {
        logger.error('Failed to destroy the Discord client cleanly', error);
      })
      .finally(() => {
        clearTimeout(watchdog);
        logger.info('Shutdown complete. Bye!');
        process.exit(exitCode);
      });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shutdown(signal, 0);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    shutdown('uncaughtException', 1);
  });
}

try {
  await main();
} catch (error) {
  fail(error);
}

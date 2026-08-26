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

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

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
    logger.info(`Received ${reason}, shutting down...`);

    // Queues, players and FFmpeg children first, then the gateway connection.
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
        logger.info('Discord client destroyed. Bye!');
      })
      .catch((error: unknown) => {
        logger.error('Failed to destroy the Discord client cleanly', error);
      })
      .finally(() => {
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

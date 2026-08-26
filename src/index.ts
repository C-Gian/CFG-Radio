import 'dotenv/config';

import { ConfigError, loadConfig } from './config/env.js';
import { attachHandlers, createClient } from './discord/client.js';
import { createCommandRegistry } from './discord/command.js';
import { commands } from './discord/commands/index.js';
import { createLogger, formatForLog, registerSecret, type Logger } from './logger.js';
import { VoiceSessionManager } from './voice/session-manager.js';

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

  attachHandlers(client, createCommandRegistry(commands), { config, logger, voice });
  installProcessHandlers({ client, voice, logger });

  logger.info('Starting CFG Radio...');
  logger.debug(
    `Config loaded (logLevel=${config.logLevel}, defaultVolume=${config.defaultVolume}, ` +
      `idleDisconnectSeconds=${config.idleDisconnectSeconds}, ffmpegPath=${config.ffmpegPath})`,
  );

  await client.login(config.discordToken);
}

interface ShutdownTargets {
  readonly client: { destroy: () => Promise<void> };
  readonly voice: { destroyAll: () => void };
  readonly logger: Logger;
}

function installProcessHandlers({ client, voice, logger }: ShutdownTargets): void {
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${reason}, shutting down...`);

    // Players and FFmpeg children first, then the gateway connection.
    try {
      voice.destroyAll();
    } catch (error) {
      logger.error(`Failed to close the voice sessions cleanly`, error);
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

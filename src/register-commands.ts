import 'dotenv/config';

import { REST, Routes } from 'discord.js';

import { ConfigError, loadConfig } from './config/env.js';
import { toApplicationCommands } from './discord/command.js';
import { commands } from './discord/commands/index.js';
import { createLogger, formatForLog, registerSecret } from './logger.js';

/**
 * Registers the slash commands for the development guild.
 *
 * Registration is an explicit, manual step: the bot runtime never touches the
 * Discord command API on startup.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  registerSecret(config.discordToken);

  const logger = createLogger(config.logLevel);
  const payload = toApplicationCommands(commands);

  logger.info(
    `Registering ${payload.length} guild command(s) for guild ${config.discordGuildId}: ` +
      payload.map((command) => `/${command.name}`).join(', '),
  );

  const rest = new REST().setToken(config.discordToken);
  const result = await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
    { body: payload },
  );

  const registered = Array.isArray(result) ? result.length : 0;
  logger.info(`Successfully registered ${registered} guild command(s).`);
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`[FATAL] ${error.message}`);
  } else {
    console.error('[FATAL] Failed to register the slash commands', formatForLog(error));
  }
  process.exit(1);
}

import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { CommandRegistry } from './command.js';
import { handleInteraction } from './interaction-handler.js';
import type { Logger } from '../logger.js';

/**
 * Creates the Discord client.
 *
 * Only the `Guilds` intent is requested: slash commands need nothing more, and
 * no privileged intent is involved.
 */
export function createClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}

/** Wires lifecycle logging and slash command dispatching onto the client. */
export function attachHandlers(client: Client, registry: CommandRegistry, logger: Logger): void {
  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag} (${readyClient.user.id})`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, registry, logger);
  });

  client.on(Events.Error, (error) => {
    logger.error('Discord client error', error);
  });

  client.on(Events.Warn, (message) => {
    logger.warn(`Discord client warning: ${message}`);
  });
}

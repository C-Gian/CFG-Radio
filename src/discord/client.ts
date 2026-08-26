import { Client, Events, GatewayIntentBits } from 'discord.js';
import type { CommandRegistry } from './command.js';
import type { CommandContext } from './context.js';
import { handleInteraction } from './interaction-handler.js';

/**
 * Creates the Discord client.
 *
 * `Guilds` covers slash commands, `GuildVoiceStates` is what lets the bot see
 * which voice channel a member is in. Neither is a privileged intent.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
}

/** Wires lifecycle logging and slash command dispatching onto the client. */
export function attachHandlers(
  client: Client,
  registry: CommandRegistry,
  context: CommandContext,
): void {
  const { logger } = context;

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Ready! Logged in as ${readyClient.user.tag} (${readyClient.user.id})`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, registry, context);
  });

  client.on(Events.Error, (error) => {
    logger.error('Discord client error', error);
  });

  client.on(Events.Warn, (message) => {
    logger.warn(`Discord client warning: ${message}`);
  });
}

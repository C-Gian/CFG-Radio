import { MessageFlags, type Interaction, type RepliableInteraction } from 'discord.js';
import type { CommandRegistry } from './command.js';
import type { CommandContext } from './context.js';
import type { Logger } from '../logger.js';

const GENERIC_ERROR_MESSAGE = 'Something went wrong while running this command.';
const UNKNOWN_COMMAND_MESSAGE = 'This command is not available anymore.';

/**
 * Replies (or follows up) without ever throwing: the interaction may already
 * have been answered, or its 3 second token may have expired.
 */
async function respondSafely(
  interaction: RepliableInteraction,
  content: string,
  logger: Logger,
): Promise<void> {
  try {
    if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else if (interaction.deferred) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    logger.error('Failed to send an error response to the interaction', error);
  }
}

/** Discord says these interactions cannot be acknowledged again. */
function isFinalInteractionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === 10062 || code === 40060 || code === '10062' || code === '40060';
}

/**
 * Routes an incoming interaction to its command.
 *
 * Never rejects: a failing command must not take the process down.
 */
export async function handleInteraction(
  interaction: Interaction,
  registry: CommandRegistry,
  context: CommandContext,
): Promise<void> {
  const { logger } = context;

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = registry.get(interaction.commandName);
  if (command === undefined) {
    logger.warn(`Received an unknown command: ${interaction.commandName}`);
    await respondSafely(interaction, UNKNOWN_COMMAND_MESSAGE, logger);
    return;
  }

  logger.debug(`Executing command: ${interaction.commandName}`);

  try {
    await command.execute(interaction, context);
  } catch (error) {
    logger.error(`Command "${interaction.commandName}" failed`, error);
    if (isFinalInteractionError(error)) {
      // A retry can only produce another Unknown Interaction / Already
      // Acknowledged response and obscure the original failure.
      return;
    }
    await respondSafely(interaction, GENERIC_ERROR_MESSAGE, logger);
  }
}

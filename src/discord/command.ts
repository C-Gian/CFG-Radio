import type {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';

/**
 * A slash command.
 *
 * Handlers stay thin on purpose: they translate a Discord interaction into a
 * call to domain code and back. No provider/playback logic lives here.
 */
export interface Command {
  readonly data: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export type CommandRegistry = ReadonlyMap<string, Command>;

/** Builds a name -> command lookup, rejecting duplicated command names. */
export function createCommandRegistry(commands: readonly Command[]): CommandRegistry {
  const registry = new Map<string, Command>();
  for (const command of commands) {
    if (registry.has(command.data.name)) {
      throw new Error(`Duplicate command name: ${command.data.name}`);
    }
    registry.set(command.data.name, command);
  }
  return registry;
}

/** Serializes commands into the payload expected by the Discord REST API. */
export function toApplicationCommands(
  commands: readonly Command[],
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return commands.map((command) => command.data.toJSON());
}

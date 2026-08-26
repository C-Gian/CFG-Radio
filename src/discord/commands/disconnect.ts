import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';

/**
 * Stops playback and leaves the voice channel.
 *
 * Idempotent: running it while the bot is idle simply says so.
 */
export const disconnect: Command = {
  data: new SlashCommandBuilder()
    .setName('disconnect')
    .setDescription('Stops playback and leaves the voice channel.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    const { guild } = interaction;
    if (guild === null) {
      await interaction.reply({
        content: 'This command only works inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const destroyed = context.voice.destroy(guild.id);

    await interaction.reply({
      content: destroyed
        ? 'Stopped playback and left the voice channel.'
        : 'I am not connected to a voice channel here.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

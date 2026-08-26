import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, resolveGuildAccess, respond } from '../guild-access.js';

/** Reads or changes the per-session live playback volume. */
export const volume: Command = {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Shows or changes playback volume.')
    .addIntegerOption((option) =>
      option
        .setName('level')
        .setDescription('Volume percentage (0 is mute).')
        .setMinValue(0)
        .setMaxValue(100),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    const level = interaction.options.getInteger('level');
    if (level === null) {
      const access = await resolveGuildAccess(interaction);
      if (access === undefined) {
        return;
      }
      const current = context.players.get(access.guild.id)?.snapshot().volume;
      await respond(interaction, `Volume is **${current ?? context.config.defaultVolume}%**.`);
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      await respond(interaction, 'Volume must be an integer from 0 to 100.');
      return;
    }

    const access = await requireControlAccess(interaction, context);
    if (access === undefined) {
      return;
    }
    const player = context.players.get(access.guild.id);
    if (player === undefined) {
      await respond(interaction, 'I am not connected to a voice channel here.');
      return;
    }

    await player.setVolume(level);
    await respond(interaction, `Volume set to **${level}%**.`);
  },
};

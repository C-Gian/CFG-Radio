import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, respond } from '../guild-access.js';

/**
 * Stops playback and clears the queue, keeping the voice connection so
 * `/playlocal` can start again without rejoining. `/disconnect` is what leaves
 * the channel.
 */
export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stops playback and clears the queue (stays in the voice channel).')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const access = await requireControlAccess(interaction, context);
    if (access === undefined) {
      return;
    }

    const player = context.players.get(access.guild.id);
    const stopped = player === undefined ? false : await player.stop();

    await respond(
      interaction,
      stopped
        ? 'Stopped playback and cleared the queue. I am still in the voice channel.'
        : 'Nothing to stop: the queue is already empty.',
    );
  },
};

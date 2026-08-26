import {
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, respond } from '../guild-access.js';

/** Ends the current track and starts the next queued one, if any. */
export const skip: Command = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skips the current track.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    const access = await requireControlAccess(interaction, context);
    if (access === undefined) {
      return;
    }

    const player = context.players.get(access.guild.id);
    if (player === undefined) {
      await respond(interaction, 'Nothing is playing right now.');
      return;
    }

    const { skipped, next } = await player.skip();

    if (skipped === undefined && next === undefined) {
      await respond(interaction, 'Nothing is playing right now.');
      return;
    }

    const skippedPart = skipped === undefined ? '' : `Skipped **${skipped.title}**. `;
    await respond(
      interaction,
      next === undefined
        ? `${skippedPart}The queue is empty, so I am idle now.`
        : `${skippedPart}Now playing **${next.title}**.`,
    );
  },
};

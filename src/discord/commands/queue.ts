import {
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { GUILD_ONLY_MESSAGE, respond } from '../guild-access.js';
import { formatQueue } from '../track-format.js';

/** Read-only: usable from anywhere in the guild, no voice channel required. */
export const queue: Command = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Shows the current track and what comes next.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    const { guild } = interaction;
    if (guild === null) {
      await respond(interaction, GUILD_ONLY_MESSAGE);
      return;
    }

    const player = context.players.get(guild.id);
    if (player === undefined) {
      await respond(interaction, 'The queue is empty and nothing is playing.');
      return;
    }

    await respond(interaction, formatQueue(player.snapshot()));
  },
};

import {
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { GUILD_ONLY_MESSAGE, respond } from '../guild-access.js';
import { formatNowPlaying } from '../track-format.js';

/** Read-only: usable from anywhere in the guild, no voice channel required. */
export const nowPlaying: Command = {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Shows what is playing right now.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    const { guild } = interaction;
    if (guild === null) {
      await respond(interaction, GUILD_ONLY_MESSAGE);
      return;
    }

    const player = context.players.get(guild.id);
    if (player === undefined) {
      await respond(interaction, 'Nothing is playing right now.');
      return;
    }

    await respond(interaction, formatNowPlaying(player.snapshot()));
  },
};

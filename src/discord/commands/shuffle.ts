import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, respond } from '../guild-access.js';

const MESSAGES = {
  empty: 'The queue is empty.',
  'one-track': 'There is only one track in the queue.',
  shuffled: 'Queue shuffled.',
} as const;

/** Randomises upcoming tracks without interrupting the current one. */
export const shuffle: Command = {
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffles the upcoming tracks.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const access = await requireControlAccess(interaction, context);
    if (access === undefined) {
      return;
    }

    const player = context.players.get(access.guild.id);
    const result = player === undefined ? 'empty' : await player.shuffle();
    await respond(interaction, MESSAGES[result]);
  },
};

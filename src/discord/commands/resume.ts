import {
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, respond } from '../guild-access.js';

const MESSAGES = {
  resumed: 'Resumed.',
  'already-playing': 'Playback is already running.',
  'nothing-playing': 'Nothing is playing right now.',
} as const;

/** Resumes a paused track. The queue is left untouched. */
export const resume: Command = {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resumes a paused track.')
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    const access = await requireControlAccess(interaction, context);
    if (access === undefined) {
      return;
    }

    const player = context.players.get(access.guild.id);
    if (player === undefined) {
      await respond(interaction, MESSAGES['nothing-playing']);
      return;
    }

    await respond(interaction, MESSAGES[player.resume()]);
  },
};

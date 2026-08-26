import {
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, respond } from '../guild-access.js';

const MESSAGES = {
  paused: 'Paused.',
  'already-paused': 'Playback is already paused. Use `/resume` to continue.',
  'nothing-playing': 'Nothing is playing right now.',
} as const;

/** Pauses the current track without touching the queue. */
export const pause: Command = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pauses the current track.')
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

    await respond(interaction, MESSAGES[player.pause()]);
  },
};

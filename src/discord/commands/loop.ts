import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import type { LoopMode } from '../../player/guild-player.js';
import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { requireControlAccess, respond } from '../guild-access.js';

const LOOP_MODES = new Set<LoopMode>(['off', 'track', 'queue']);
const MESSAGES: Record<LoopMode, string> = {
  off: 'Loop disabled.',
  track: 'Loop mode: **Track**.',
  queue: 'Loop mode: **Queue**.',
};

/** Selects how successful natural track endings affect the queue. */
export const loop: Command = {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Changes the playback loop mode.')
    .addStringOption((option) =>
      option
        .setName('mode')
        .setDescription('Loop mode.')
        .setRequired(true)
        .addChoices(
          { name: 'Off', value: 'off' },
          { name: 'Track', value: 'track' },
          { name: 'Queue', value: 'queue' },
        ),
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawMode = interaction.options.getString('mode', true);
    if (!LOOP_MODES.has(rawMode as LoopMode)) {
      await respond(interaction, 'Loop mode must be off, track or queue.');
      return;
    }
    const mode = rawMode as LoopMode;

    const access = await requireControlAccess(interaction, context);
    if (access === undefined) {
      return;
    }
    const player = context.players.get(access.guild.id);
    if (player === undefined) {
      await respond(interaction, 'I am not connected to a voice channel here.');
      return;
    }

    await player.setLoopMode(mode);
    await respond(interaction, MESSAGES[mode]);
  },
};

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../command.js';

export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Checks that CFG Radio is alive.'),
  async execute(interaction) {
    await interaction.reply({ content: 'Pong!', flags: MessageFlags.Ephemeral });
  },
};

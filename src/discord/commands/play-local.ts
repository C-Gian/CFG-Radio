import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { DEFAULT_LOCAL_ASSET_ID, LOCAL_ASSETS, findLocalAsset } from '../../audio/local-catalog.js';
import { createTrack } from '../../player/track.js';
import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { respond } from '../guild-access.js';
import { enqueueMessage, resolvePlaybackTarget } from '../play-flow.js';

const TRACK_OPTION = 'track';

/**
 * Temporary command: queues one of the bundled synthetic assets.
 *
 * It shares the whole queue and player path with `/play`, which makes it the
 * cheapest way to exercise FIFO, auto-next and the controls without touching
 * the network.
 */
export const playLocal: Command = {
  data: new SlashCommandBuilder()
    .setName('playlocal')
    .setDescription('Queues one of the bundled test tones (voice pipeline smoke test).')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName(TRACK_OPTION)
        .setDescription('Which test tone to play')
        .addChoices(...LOCAL_ASSETS.map((asset) => ({ name: asset.title, value: asset.id }))),
    ),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const assetId = interaction.options.getString(TRACK_OPTION) ?? DEFAULT_LOCAL_ASSET_ID;
    const asset = findLocalAsset(assetId);
    if (asset === undefined) {
      await respond(interaction, 'That test tone does not exist.');
      return;
    }

    const target = await resolvePlaybackTarget(interaction, context);
    if (target === undefined) {
      return;
    }

    const track = createTrack({
      title: asset.title,
      source: 'local',
      sourceId: asset.id,
      originalInput: assetId,
      requestedByUserId: interaction.user.id,
      durationMs: asset.durationMs,
    });

    try {
      const player = await context.players.join({
        guildId: target.guild.id,
        channelId: target.channelId,
        adapterCreator: target.guild.voiceAdapterCreator,
      });

      const result = await player.enqueue(track);
      await respond(interaction, enqueueMessage(result, target.channel.toString()));
    } catch (error) {
      context.logger.error(`/playlocal failed in guild ${target.guild.id}`, error);
      await respond(
        interaction,
        'I could not join your voice channel. Check that I can connect and speak there, then try again.',
      );
    }
  },
};

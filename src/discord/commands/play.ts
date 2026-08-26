import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { toYouTubeTrack } from '../../youtube/metadata.js';
import { classifyInput } from '../../youtube/url.js';
import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { providerErrorMessage, unsupportedInputMessage } from '../error-messages.js';
import { respond } from '../guild-access.js';
import { enqueueMessage, resolvePlaybackTarget } from '../play-flow.js';

const URL_OPTION = 'url';

/**
 * Plays a single YouTube video.
 *
 * Only the metadata is resolved here: the playable media URL is fetched later,
 * when the player is actually about to start this track.
 */
export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a YouTube video in your voice channel.')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName(URL_OPTION)
        .setDescription('YouTube video URL (playlists and search are not supported yet)')
        .setRequired(true),
    ),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const rawInput = interaction.options.getString(URL_OPTION, true);
    const classified = classifyInput(rawInput);
    if (classified.kind === 'unsupported') {
      await respond(interaction, unsupportedInputMessage(classified.reason));
      return;
    }

    const target = await resolvePlaybackTarget(interaction, context);
    if (target === undefined) {
      return;
    }

    let track;
    try {
      const metadata = await context.youtube.fetchMetadata(
        classified.canonicalUrl,
        classified.videoId,
      );
      track = toYouTubeTrack({
        metadata,
        requestedByUserId: interaction.user.id,
        originalInput: rawInput,
      });
    } catch (error) {
      context.logger.warn(
        `/play could not resolve ${classified.videoId} in guild ${target.guild.id}`,
        error,
      );
      await respond(interaction, providerErrorMessage(error));
      return;
    }

    try {
      const player = await context.players.join({
        guildId: target.guild.id,
        channelId: target.channelId,
        adapterCreator: target.guild.voiceAdapterCreator,
      });

      const result = await player.enqueue(track);
      await respond(interaction, enqueueMessage(result, target.channel.toString()));
    } catch (error) {
      context.logger.error(`/play failed in guild ${target.guild.id}`, error);
      await respond(
        interaction,
        'I could not join your voice channel. Check that I can connect and speak there, then try again.',
      );
    }
  },
};

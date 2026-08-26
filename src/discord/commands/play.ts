import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { toYouTubeTrack } from '../../youtube/metadata.js';
import type { EnqueueManyResult } from '../../player/guild-player.js';
import { playlistItemsToTracks, type YouTubePlaylistImport } from '../../youtube/playlist.js';
import { classifyInput } from '../../youtube/url.js';
import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import {
  playlistProviderErrorMessage,
  providerErrorMessage,
  unsupportedInputMessage,
} from '../error-messages.js';
import { respond } from '../guild-access.js';
import { enqueueMessage, resolvePlaybackTarget } from '../play-flow.js';

const URL_OPTION = 'url';

/**
 * Plays a YouTube video or imports a playlist.
 *
 * Only the metadata is resolved here: the playable media URL is fetched later,
 * when the player is actually about to start this track.
 */
export const play: Command = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Plays a YouTube video or playlist in your voice channel.')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName(URL_OPTION)
        .setDescription('YouTube video or playlist URL (search is not supported)')
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

    if (classified.kind === 'youtube-video') {
      let track;
      let immediateSource;
      try {
        // One extraction yields both the identity and a runtime-only source:
        // asking twice used to double the wait before the first note.
        const resolved = await context.youtube.fetchMetadataWithSource(
          classified.canonicalUrl,
          classified.videoId,
        );
        immediateSource = resolved.source;
        track = toYouTubeTrack({
          metadata: resolved.metadata,
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

        // The source is used only if this track starts now; a queued track
        // is resolved late, exactly as before.
        const result = await player.enqueue(track, immediateSource);
        await respond(interaction, enqueueMessage(result, target.channel.toString()));
      } catch (error) {
        await answerJoinFailure(interaction, context, target.guild.id, error);
      }
      return;
    }

    let playlist: YouTubePlaylistImport;
    try {
      playlist = await context.youtube.fetchPlaylist(
        classified.canonicalUrl,
        classified.playlistId,
        context.config.maxPlaylistTracks,
      );
    } catch (error) {
      context.logger.warn(
        `/play could not resolve playlist ${classified.playlistId} in guild ${target.guild.id}`,
        error,
      );
      await respond(interaction, playlistProviderErrorMessage(error));
      return;
    }

    const tracks = playlistItemsToTracks(playlist, interaction.user.id, rawInput);
    if (tracks.length === 0) {
      const skipped =
        playlist.skippedCount > 0 ? ` ${skippedEntriesMessage(playlist.skippedCount)}` : '';
      await respond(interaction, `This playlist has no playable tracks.${skipped}`);
      return;
    }

    try {
      const player = await context.players.join({
        guildId: target.guild.id,
        channelId: target.channelId,
        adapterCreator: target.guild.voiceAdapterCreator,
      });
      const result = await player.enqueueMany(tracks);
      await respond(
        interaction,
        playlistEnqueueMessage(result, playlist, target.channel.toString()),
      );
    } catch (error) {
      await answerJoinFailure(interaction, context, target.guild.id, error);
    }
  },
};

function playlistEnqueueMessage(
  result: EnqueueManyResult,
  playlist: YouTubePlaylistImport,
  channelMention: string,
): string {
  const count = result.tracks.length;
  const qualifier = playlist.limited ? 'first ' : '';
  const added = `Added ${qualifier}**${count} tracks** from playlist **${playlist.playlist.title}**`;
  const lines: string[] = [];

  if (result.kind === 'started') {
    lines.push(`Playing **${result.track.title}** in ${channelMention}.`, `${added}.`);
  } else if (result.kind === 'queued') {
    lines.push(`${added} to the queue.`);
  } else {
    lines.push(`${added}, but playback could not start. ${providerErrorMessage(result.error)}`);
  }

  if (playlist.skippedCount > 0) {
    lines.push(skippedEntriesMessage(playlist.skippedCount));
  }
  if (playlist.limited) {
    lines.push(`Playlist was limited to ${count} tracks.`);
  }
  return lines.join('\n');
}

function skippedEntriesMessage(count: number): string {
  return count === 1
    ? '1 unavailable entry was skipped.'
    : `${count} unavailable entries were skipped.`;
}

async function answerJoinFailure(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
  guildId: string,
  error: unknown,
): Promise<void> {
  context.logger.error(`/play failed in guild ${guildId}`, error);
  await respond(
    interaction,
    'I could not join your voice channel. Check that I can connect and speak there, then try again.',
  );
}

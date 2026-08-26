import {
  InteractionContextType,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';

import { DEFAULT_LOCAL_ASSET_ID, LOCAL_ASSETS, findLocalAsset } from '../../audio/local-catalog.js';
import { createTrack } from '../../player/track.js';
import { decidePlayLocal } from '../../voice/policy.js';
import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';
import { respond, resolveGuildAccess } from '../guild-access.js';

const TRACK_OPTION = 'track';

/** Permissions the bot needs in the target channel. */
function missingPermissions(channel: VoiceBasedChannel, me: GuildMember): string[] {
  const permissions = channel.permissionsFor(me);
  const missing: string[] = [];
  if (!permissions.has(PermissionsBitField.Flags.Connect)) {
    missing.push('Connect');
  }
  if (!permissions.has(PermissionsBitField.Flags.Speak)) {
    missing.push('Speak');
  }
  return missing;
}

/**
 * Temporary milestone 3 command: feeds the queue with the bundled synthetic
 * assets so FIFO, auto-next and the playback controls can be verified by ear.
 *
 * It is deliberately limited to the local catalog; real sources arrive with
 * the provider milestones and will reuse the same queue and player.
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

    const access = await resolveGuildAccess(interaction);
    if (access === undefined) {
      return;
    }
    const { guild, member } = access;

    const assetId = interaction.options.getString(TRACK_OPTION) ?? DEFAULT_LOCAL_ASSET_ID;
    const asset = findLocalAsset(assetId);
    if (asset === undefined) {
      await respond(interaction, 'That test tone does not exist.');
      return;
    }

    const decision = decidePlayLocal({
      userChannelId: access.userChannelId,
      sessionChannelId: context.players.channelIdOf(guild.id),
    });

    if (decision.kind === 'reject') {
      await respond(interaction, decision.message);
      return;
    }

    const channel = member.voice.channel;
    if (channel === null) {
      await respond(interaction, 'Join a voice channel first, then run the command again.');
      return;
    }

    const missing = missingPermissions(
      channel,
      guild.members.me ?? (await guild.members.fetchMe()),
    );
    if (missing.length > 0) {
      await respond(
        interaction,
        `I am missing the following permission(s) in ${channel.toString()}: ${missing.join(', ')}.`,
      );
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
        guildId: guild.id,
        channelId: decision.channelId,
        adapterCreator: guild.voiceAdapterCreator,
      });

      const result = await player.enqueue(track);

      if (result.kind === 'started') {
        await respond(interaction, `Playing **${track.title}** in ${channel.toString()}.`);
        return;
      }
      if (result.kind === 'queued') {
        await respond(
          interaction,
          `Added **${track.title}** to the queue, position ${result.position}.`,
        );
        return;
      }
      await respond(interaction, 'I could not start that track. Nothing changed in the queue.');
    } catch (error) {
      context.logger.error(`/playlocal failed in guild ${guild.id}`, error);
      await respond(
        interaction,
        'I could not join your voice channel. Check that I can connect and speak there, then try again.',
      );
    }
  },
};

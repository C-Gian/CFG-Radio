import {
  InteractionContextType,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';

import {
  TEST_TONE_DESCRIPTION,
  TEST_TONE_PATH,
  assertTestToneExists,
} from '../../audio/test-tone.js';
import { decidePlayLocal } from '../../voice/policy.js';
import type { Command } from '../command.js';
import type { CommandContext } from '../context.js';

const GUILD_ONLY_MESSAGE = 'This command only works inside a server.';

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
 * Temporary milestone 2 command: plays the bundled synthetic tone to prove the
 * Discord -> voice connection -> AudioPlayer -> FFmpeg pipeline really works.
 *
 * It is deliberately limited to that one asset; real sources arrive with the
 * provider milestones.
 */
export const playLocal: Command = {
  data: new SlashCommandBuilder()
    .setName('playlocal')
    .setDescription(
      'Plays the bundled test tone in your voice channel (voice pipeline smoke test).',
    )
    .setContexts(InteractionContextType.Guild),

  async execute(interaction: ChatInputCommandInteraction, context: CommandContext) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { guild } = interaction;
    if (guild === null) {
      await interaction.editReply(GUILD_ONLY_MESSAGE);
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const me = guild.members.me ?? (await guild.members.fetchMe());

    const decision = decidePlayLocal({
      userChannelId: member.voice.channelId,
      sessionChannelId: context.voice.get(guild.id)?.channelId,
    });

    if (decision.kind === 'reject') {
      await interaction.editReply(decision.message);
      return;
    }

    const channel = member.voice.channel;
    if (channel === null) {
      await interaction.editReply(GUILD_ONLY_MESSAGE);
      return;
    }

    const missing = missingPermissions(channel, me);
    if (missing.length > 0) {
      await interaction.editReply(
        `I am missing the following permission(s) in ${channel.toString()}: ${missing.join(', ')}.`,
      );
      return;
    }

    try {
      await assertTestToneExists();

      const session = await context.voice.join({
        guildId: guild.id,
        channelId: decision.channelId,
        adapterCreator: guild.voiceAdapterCreator,
      });

      await session.play(TEST_TONE_PATH);

      await interaction.editReply(
        `Playing the ${TEST_TONE_DESCRIPTION} in ${channel.toString()}. Use \`/disconnect\` when you are done.`,
      );
    } catch (error) {
      context.logger.error(`/playlocal failed in guild ${guild.id}`, error);
      // Leave no half-open session behind after a failed attempt.
      context.voice.destroy(guild.id);
      await interaction.editReply(
        'I could not start playback. Check that I can join and speak in your channel, then try again.',
      );
    }
  },
};

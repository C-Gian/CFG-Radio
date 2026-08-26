import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from 'discord.js';

import { decideControl } from '../voice/policy.js';
import type { CommandContext } from './context.js';

export const GUILD_ONLY_MESSAGE = 'This command only works inside a server.';

/** Replies, or edits the deferred answer - whichever the interaction needs. */
export async function respond(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content);
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export interface GuildAccess {
  readonly guild: Guild;
  readonly member: GuildMember;
  readonly userChannelId: string | null;
}

/**
 * Resolves the guild context of a command, answering the user when it is not
 * usable.
 *
 * @returns `undefined` when the command must stop (already answered).
 */
export async function resolveGuildAccess(
  interaction: ChatInputCommandInteraction,
): Promise<GuildAccess | undefined> {
  const { guild } = interaction;
  if (guild === null) {
    await respond(interaction, GUILD_ONLY_MESSAGE);
    return undefined;
  }

  const member = await guild.members.fetch(interaction.user.id);
  return { guild, member, userChannelId: member.voice.channelId };
}

/**
 * Same as {@link resolveGuildAccess}, plus the shared voice-channel rule for
 * mutating commands: while the bot is connected, only members of its channel
 * may control playback.
 *
 * Used by every mutating handler so the policy is never duplicated.
 */
export async function requireControlAccess(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<GuildAccess | undefined> {
  const access = await resolveGuildAccess(interaction);
  if (access === undefined) {
    return undefined;
  }

  const decision = decideControl({
    userChannelId: access.userChannelId,
    sessionChannelId: context.players.channelIdOf(access.guild.id),
  });

  if (decision.kind === 'reject') {
    await respond(interaction, decision.message);
    return undefined;
  }

  return access;
}

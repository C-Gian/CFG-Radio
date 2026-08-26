import {
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type VoiceBasedChannel,
} from 'discord.js';

import type { EnqueueResult } from '../player/guild-player.js';
import { decidePlayLocal } from '../voice/policy.js';
import type { CommandContext } from './context.js';
import { providerErrorMessage } from './error-messages.js';
import { respond, resolveGuildAccess } from './guild-access.js';

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

export interface PlaybackTarget {
  readonly guild: Guild;
  readonly channel: VoiceBasedChannel;
  readonly channelId: string;
}

/**
 * Everything `/play` and `/playlocal` must check before touching a provider:
 * guild, voice channel, the shared voice policy and the bot's permissions.
 *
 * Answers the user and returns `undefined` when the command must stop. It does
 * not join yet - metadata resolution happens first, so the bot never walks into
 * a channel only to fail.
 */
export async function resolvePlaybackTarget(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
): Promise<PlaybackTarget | undefined> {
  const access = await resolveGuildAccess(interaction);
  if (access === undefined) {
    return undefined;
  }
  const { guild, member } = access;

  const decision = decidePlayLocal({
    userChannelId: access.userChannelId,
    sessionChannelId: context.players.channelIdOf(guild.id),
  });

  if (decision.kind === 'reject') {
    await respond(interaction, decision.message);
    return undefined;
  }

  const channel = member.voice.channel;
  if (channel === null) {
    await respond(interaction, 'Join a voice channel first, then run the command again.');
    return undefined;
  }

  const missing = missingPermissions(channel, guild.members.me ?? (await guild.members.fetchMe()));
  if (missing.length > 0) {
    await respond(
      interaction,
      `I am missing the following permission(s) in ${channel.toString()}: ${missing.join(', ')}.`,
    );
    return undefined;
  }

  return { guild, channel, channelId: decision.channelId };
}

/** The answer for an enqueue outcome, identical for every source. */
export function enqueueMessage(result: EnqueueResult, channelMention: string): string {
  switch (result.kind) {
    case 'started':
      return `Playing **${result.track.title}** in ${channelMention}.`;
    case 'queued':
      return `Added to queue at position ${result.position}: **${result.track.title}**.`;
    case 'failed':
      return `I could not start **${result.track.title}**. ${providerErrorMessage(result.error)}`;
  }
}

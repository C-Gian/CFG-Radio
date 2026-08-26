/**
 * Decides what `/playlocal` should do, given where the user is and what the
 * bot is already doing in that guild.
 *
 * Pure on purpose: the policy is the part worth testing, and it must not
 * depend on discord.js internals.
 */
export type PlayLocalDecision =
  | { readonly kind: 'join'; readonly channelId: string }
  | { readonly kind: 'reuse'; readonly channelId: string }
  | { readonly kind: 'reject'; readonly message: string };

export interface PlayLocalInput {
  /** Voice channel the requesting user is in, if any. */
  readonly userChannelId: string | null;
  /** Channel the bot is already connected to in this guild, if any. */
  readonly sessionChannelId: string | null | undefined;
}

export const NOT_IN_VOICE_MESSAGE = 'Join a voice channel first, then run `/playlocal` again.';

export const BUSY_ELSEWHERE_MESSAGE =
  'I am already connected to another voice channel in this server. Use `/disconnect` first.';

export function decidePlayLocal(input: PlayLocalInput): PlayLocalDecision {
  if (input.userChannelId === null) {
    return { kind: 'reject', message: NOT_IN_VOICE_MESSAGE };
  }

  const { sessionChannelId } = input;
  if (sessionChannelId === undefined || sessionChannelId === null) {
    return { kind: 'join', channelId: input.userChannelId };
  }

  if (sessionChannelId !== input.userChannelId) {
    // Moving the bot without being asked would be surprising: refuse instead.
    return { kind: 'reject', message: BUSY_ELSEWHERE_MESSAGE };
  }

  return { kind: 'reuse', channelId: sessionChannelId };
}

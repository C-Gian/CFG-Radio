/**
 * Where the bot is allowed to play, and who is allowed to control it.
 *
 * Pure on purpose: this is the part worth testing, and it must not depend on
 * discord.js internals. Every mutating command goes through `decideControl`,
 * so the rule lives in exactly one place.
 */
export type PlayLocalDecision =
  | { readonly kind: 'join'; readonly channelId: string }
  | { readonly kind: 'reuse'; readonly channelId: string }
  | { readonly kind: 'reject'; readonly message: string };

export type ControlDecision =
  { readonly kind: 'allow' } | { readonly kind: 'reject'; readonly message: string };

export interface VoicePolicyInput {
  /** Voice channel the requesting user is in, if any. */
  readonly userChannelId: string | null;
  /** Channel the bot is connected to in this guild, if any. */
  readonly sessionChannelId: string | null | undefined;
}

export const NOT_IN_VOICE_MESSAGE = 'Join a voice channel first, then run the command again.';

export const BUSY_ELSEWHERE_MESSAGE =
  'I am already connected to another voice channel in this server. Use `/disconnect` first.';

export const NOT_SAME_CHANNEL_MESSAGE = 'You have to be in my voice channel to control playback.';

export function decidePlayLocal(input: VoicePolicyInput): PlayLocalDecision {
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

/**
 * Whether a user may run a mutating command (`/pause`, `/resume`, `/skip`,
 * `/stop`, `/volume level`, `/shuffle`, `/loop`, `/disconnect`).
 *
 * While the bot is connected, only members of its own channel may control it.
 * When it is not connected there is nothing to protect, so the command runs
 * and answers for itself ("nothing is playing").
 */
export function decideControl(input: VoicePolicyInput): ControlDecision {
  const { sessionChannelId } = input;
  if (sessionChannelId === undefined || sessionChannelId === null) {
    return { kind: 'allow' };
  }

  if (input.userChannelId === null) {
    return { kind: 'reject', message: NOT_IN_VOICE_MESSAGE };
  }

  if (input.userChannelId !== sessionChannelId) {
    return { kind: 'reject', message: NOT_SAME_CHANNEL_MESSAGE };
  }

  return { kind: 'allow' };
}

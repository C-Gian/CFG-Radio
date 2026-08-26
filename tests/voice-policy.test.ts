import { describe, expect, it } from 'vitest';

import {
  BUSY_ELSEWHERE_MESSAGE,
  NOT_IN_VOICE_MESSAGE,
  NOT_SAME_CHANNEL_MESSAGE,
  decideControl,
  decidePlayLocal,
} from '../src/voice/policy.js';

describe('decidePlayLocal', () => {
  it('refuses when the user is not in a voice channel', () => {
    expect(decidePlayLocal({ userChannelId: null, sessionChannelId: undefined })).toEqual({
      kind: 'reject',
      message: NOT_IN_VOICE_MESSAGE,
    });
  });

  it('joins when the bot has no session in the guild', () => {
    expect(decidePlayLocal({ userChannelId: 'vc-1', sessionChannelId: undefined })).toEqual({
      kind: 'join',
      channelId: 'vc-1',
    });
  });

  it('joins when a session exists without a channel', () => {
    expect(decidePlayLocal({ userChannelId: 'vc-1', sessionChannelId: null })).toEqual({
      kind: 'join',
      channelId: 'vc-1',
    });
  });

  it('reuses the connection when the user is in the same channel', () => {
    expect(decidePlayLocal({ userChannelId: 'vc-1', sessionChannelId: 'vc-1' })).toEqual({
      kind: 'reuse',
      channelId: 'vc-1',
    });
  });

  it('refuses instead of moving when the bot is busy in another channel', () => {
    expect(decidePlayLocal({ userChannelId: 'vc-2', sessionChannelId: 'vc-1' })).toEqual({
      kind: 'reject',
      message: BUSY_ELSEWHERE_MESSAGE,
    });
  });

  it('prefers the "not in voice" message when the user is in no channel at all', () => {
    expect(decidePlayLocal({ userChannelId: null, sessionChannelId: 'vc-1' })).toEqual({
      kind: 'reject',
      message: NOT_IN_VOICE_MESSAGE,
    });
  });
});

describe('decideControl', () => {
  it('allows the command when the bot is not connected', () => {
    expect(decideControl({ userChannelId: null, sessionChannelId: undefined })).toEqual({
      kind: 'allow',
    });
    expect(decideControl({ userChannelId: 'vc-1', sessionChannelId: null })).toEqual({
      kind: 'allow',
    });
  });

  it('allows a member of the same voice channel', () => {
    expect(decideControl({ userChannelId: 'vc-1', sessionChannelId: 'vc-1' })).toEqual({
      kind: 'allow',
    });
  });

  it('refuses a member of another voice channel', () => {
    expect(decideControl({ userChannelId: 'vc-2', sessionChannelId: 'vc-1' })).toEqual({
      kind: 'reject',
      message: NOT_SAME_CHANNEL_MESSAGE,
    });
  });

  it('refuses someone who is not in voice at all while the bot is connected', () => {
    expect(decideControl({ userChannelId: null, sessionChannelId: 'vc-1' })).toEqual({
      kind: 'reject',
      message: NOT_IN_VOICE_MESSAGE,
    });
  });
});

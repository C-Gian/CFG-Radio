import { describe, expect, it } from 'vitest';

import { loop } from '../src/discord/commands/loop.js';
import { shuffle } from '../src/discord/commands/shuffle.js';
import { volume } from '../src/discord/commands/volume.js';
import { contextWithPlayer, fakeChatInput, fakeContext, replyContent } from './helpers/context.js';
import { localTrack } from './helpers/fake-transport.js';

describe('/volume', () => {
  it('registers an optional integer constrained to 0-100', () => {
    const json = volume.data.toJSON();
    const option = json.options?.[0] as
      { required?: boolean; min_value?: number; max_value?: number } | undefined;

    expect(option).toMatchObject({ required: false, min_value: 0, max_value: 100 });
  });

  it('queries current volume read-only from outside voice', async () => {
    const { context, player } = contextWithPlayer();
    await player.setVolume(45);
    const call = fakeChatInput({ userChannelId: null });

    await volume.execute(call.interaction, context);

    expect(replyContent(call.reply)).toBe('Volume is **45%**.');
    expect(call.deferReply).not.toHaveBeenCalled();
  });

  it('shows configured default when no session exists', async () => {
    const { context } = fakeContext();
    const call = fakeChatInput({ userChannelId: null });

    await volume.execute(call.interaction, context);

    expect(replyContent(call.reply)).toBe('Volume is **100%**.');
  });

  it.each([0, 50, 100])('sets %i%% and defers before the mutation', async (level) => {
    const { context, player } = contextWithPlayer();
    const call = fakeChatInput({ integerOptions: { level } });

    await volume.execute(call.interaction, context);

    expect(player.snapshot().volume).toBe(level);
    expect(replyContent(call.reply)).toBe(`Volume set to **${level}%**.`);
    expect(call.deferReply).toHaveBeenCalledTimes(1);
    expect(call.editReply).toHaveBeenCalledTimes(1);
    expect(call.interactionReply).not.toHaveBeenCalled();
  });

  it('validates an out-of-range runtime payload without touching the player', async () => {
    const { context, player } = contextWithPlayer();
    const call = fakeChatInput({ integerOptions: { level: 101 } });

    await volume.execute(call.interaction, context);

    expect(replyContent(call.reply)).toContain('integer from 0 to 100');
    expect(player.snapshot().volume).toBe(100);
  });

  it('requires the same voice channel only when setting', async () => {
    const { context, player } = contextWithPlayer();
    const call = fakeChatInput({ userChannelId: 'vc-2', integerOptions: { level: 20 } });

    await volume.execute(call.interaction, context);

    expect(replyContent(call.reply)).toContain('in my voice channel');
    expect(player.snapshot().volume).toBe(100);
  });

  it('answers cleanly when setting without a session', async () => {
    const { context } = fakeContext();
    const call = fakeChatInput({ integerOptions: { level: 20 } });

    await volume.execute(call.interaction, context);

    expect(replyContent(call.reply)).toContain('not connected');
  });
});

describe('/shuffle', () => {
  it.each([
    [0, 'The queue is empty.'],
    [1, 'There is only one track in the queue.'],
  ])('handles %i upcoming tracks', async (count, expected) => {
    const { context, player } = contextWithPlayer();
    if (count === 1) {
      await player.enqueueMany([localTrack('a'), localTrack('b')]);
    }
    const call = fakeChatInput();

    await shuffle.execute(call.interaction, context);

    expect(replyContent(call.reply)).toBe(expected);
  });

  it('keeps current and confirms a multi-track shuffle once', async () => {
    const { context, player } = contextWithPlayer();
    const a = localTrack('a');
    await player.enqueueMany([a, localTrack('b'), localTrack('c')]);
    const call = fakeChatInput();

    await shuffle.execute(call.interaction, context);

    expect(player.current).toBe(a);
    expect(replyContent(call.reply)).toBe('Queue shuffled.');
    expect(call.deferReply).toHaveBeenCalledTimes(1);
    expect(call.editReply).toHaveBeenCalledTimes(1);
    expect(call.interactionReply).not.toHaveBeenCalled();
  });
});

describe('/loop', () => {
  it('registers static off, track and queue choices', () => {
    const json = loop.data.toJSON();
    const option = json.options?.[0] as { choices?: { value: string }[] } | undefined;
    expect(option?.choices?.map(({ value }) => value)).toEqual(['off', 'track', 'queue']);
  });

  it.each([
    ['off', 'Loop disabled.'],
    ['track', 'Loop mode: **Track**.'],
    ['queue', 'Loop mode: **Queue**.'],
  ] as const)('sets %s with compact deferred UX', async (mode, expected) => {
    const { context, player } = contextWithPlayer();
    const call = fakeChatInput({ stringOptions: { mode } });

    await loop.execute(call.interaction, context);

    expect(player.snapshot().loopMode).toBe(mode);
    expect(replyContent(call.reply)).toBe(expected);
    expect(call.deferReply).toHaveBeenCalledTimes(1);
    expect(call.editReply).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid runtime choice', async () => {
    const { context, player } = contextWithPlayer();
    const call = fakeChatInput({ stringOptions: { mode: 'forever' } });

    await loop.execute(call.interaction, context);

    expect(replyContent(call.reply)).toContain('off, track or queue');
    expect(player.snapshot().loopMode).toBe('off');
  });

  it('answers cleanly without an active session', async () => {
    const { context } = fakeContext();
    const call = fakeChatInput({ stringOptions: { mode: 'queue' } });

    await loop.execute(call.interaction, context);

    expect(replyContent(call.reply)).toContain('not connected');
  });
});

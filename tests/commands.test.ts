import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  createCommandRegistry,
  toApplicationCommands,
  type Command,
} from '../src/discord/command.js';
import { commands } from '../src/discord/commands/index.js';
import { handleInteraction } from '../src/discord/interaction-handler.js';
import { disconnect } from '../src/discord/commands/disconnect.js';
import { nowPlaying } from '../src/discord/commands/nowplaying.js';
import { pause } from '../src/discord/commands/pause.js';
import { play } from '../src/discord/commands/play.js';
import { ping } from '../src/discord/commands/ping.js';
import { playLocal } from '../src/discord/commands/play-local.js';
import { queue } from '../src/discord/commands/queue.js';
import { resume } from '../src/discord/commands/resume.js';
import { skip } from '../src/discord/commands/skip.js';
import { stop } from '../src/discord/commands/stop.js';
import { volume } from '../src/discord/commands/volume.js';
import { shuffle } from '../src/discord/commands/shuffle.js';
import { loop } from '../src/discord/commands/loop.js';
import { LOCAL_ASSETS } from '../src/audio/local-catalog.js';
import { localTrack } from './helpers/fake-transport.js';
import { contextWithPlayer, fakeChatInput, fakeContext, replyContent } from './helpers/context.js';

const EXPECTED_COMMANDS = [
  'disconnect',
  'loop',
  'nowplaying',
  'pause',
  'ping',
  'play',
  'playlocal',
  'queue',
  'resume',
  'shuffle',
  'skip',
  'stop',
  'volume',
];

function fakeCommand(name: string): Command {
  return {
    data: { name, toJSON: () => ({ name, description: name }) },
    execute: () => Promise.resolve(),
  };
}

describe('command registry', () => {
  it('ships the complete milestone 6 command set', () => {
    const registry = createCommandRegistry(commands);

    expect([...registry.keys()].sort()).toEqual(EXPECTED_COMMANDS);
    expect(registry.get('ping')).toBe(ping);
    expect(registry.get('play')).toBe(play);
    expect(registry.get('playlocal')).toBe(playLocal);
    expect(registry.get('pause')).toBe(pause);
    expect(registry.get('resume')).toBe(resume);
    expect(registry.get('skip')).toBe(skip);
    expect(registry.get('stop')).toBe(stop);
    expect(registry.get('queue')).toBe(queue);
    expect(registry.get('nowplaying')).toBe(nowPlaying);
    expect(registry.get('disconnect')).toBe(disconnect);
    expect(registry.get('volume')).toBe(volume);
    expect(registry.get('shuffle')).toBe(shuffle);
    expect(registry.get('loop')).toBe(loop);
  });

  it('rejects duplicated command names', () => {
    expect(() => createCommandRegistry([fakeCommand('dup'), fakeCommand('dup')])).toThrow(
      /Duplicate command name: dup/,
    );
  });

  it('serialises every command for the Discord REST API', () => {
    const payload = toApplicationCommands(commands);

    expect(payload).toHaveLength(commands.length);
    expect(payload.map((command) => command.name).sort()).toEqual(EXPECTED_COMMANDS);
    expect(payload.every((command) => command.description.length > 0)).toBe(true);
  });

  it('requires a url option on /play', () => {
    const json = play.data.toJSON();
    const option = json.options?.[0] as { name?: string; required?: boolean } | undefined;

    expect(option?.name).toBe('url');
    expect(option?.required).toBe(true);
  });

  it('offers one /playlocal choice per bundled asset', () => {
    const json = playLocal.data.toJSON();
    const option = json.options?.[0] as { choices?: { value: string }[] } | undefined;

    expect(option?.choices?.map((choice) => choice.value)).toEqual(
      LOCAL_ASSETS.map((asset) => asset.id),
    );
  });
});

describe('/ping', () => {
  it('replies with Pong!', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await ping.execute(interaction, fakeContext().context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(replyContent(reply)).toBe('Pong!');
  });
});

describe('/playlocal', () => {
  it('starts the default tone when the player is idle', async () => {
    const { context, player } = contextWithPlayer('guild-1', null);
    const { interaction, reply, deferReply, editReply, interactionReply } = fakeChatInput();

    await playLocal.execute(interaction, context);

    expect(replyContent(reply)).toContain('Playing **Test tone: arpeggio**');
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
    expect(player.current).toMatchObject({ source: 'local', sourceId: 'arpeggio' });
  });

  it('queues the chosen tone behind the current track', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('arpeggio'));
    const { interaction, reply } = fakeChatInput({ stringOptions: { track: 'descending' } });

    await playLocal.execute(interaction, context);

    expect(replyContent(reply)).toBe(
      'Added to queue at position 1: **Test tone: descending scale**.',
    );
    expect(player.snapshot().upcoming[0]).toMatchObject({ sourceId: 'descending' });
  });

  it('refuses an unknown tone', async () => {
    const { context } = contextWithPlayer();
    const { interaction, reply } = fakeChatInput({ stringOptions: { track: 'nope' } });

    await playLocal.execute(interaction, context);

    expect(replyContent(reply)).toContain('does not exist');
  });
});

describe('voice channel policy for mutating commands', () => {
  it.each([
    ['pause', pause],
    ['resume', resume],
    ['skip', skip],
    ['stop', stop],
    ['disconnect', disconnect],
    ['volume', volume],
    ['shuffle', shuffle],
    ['loop', loop],
  ])('/%s refuses a user in another voice channel', async (_name, command) => {
    const { context, player } = contextWithPlayer('guild-1', 'vc-1');
    await player.enqueue(localTrack('a'));
    const options =
      command === volume
        ? { integerOptions: { level: 50 } }
        : command === loop
          ? { stringOptions: { mode: 'track' } }
          : {};
    const { interaction, reply } = fakeChatInput({ userChannelId: 'vc-2', ...options });

    await command.execute(interaction, context);

    expect(replyContent(reply)).toContain('in my voice channel');
    expect(player.current).toBeDefined();
  });

  it.each([
    ['pause', pause],
    ['skip', skip],
  ])('/%s refuses a user who is not in voice at all', async (_name, command) => {
    const { context, player } = contextWithPlayer('guild-1', 'vc-1');
    await player.enqueue(localTrack('a'));
    const { interaction, reply } = fakeChatInput({ userChannelId: null });

    await command.execute(interaction, context);

    expect(replyContent(reply)).toContain('Join a voice channel first');
  });

  it.each([
    ['queue', queue, 'Track a'],
    ['nowplaying', nowPlaying, 'Track a'],
    ['volume', volume, 'Volume is'],
  ])('/%s is read-only and works from outside the voice channel', async (_name, command, text) => {
    const { context, player } = contextWithPlayer('guild-1', 'vc-1');
    await player.enqueue(localTrack('a'));
    const { interaction, reply } = fakeChatInput({ userChannelId: null });

    await command.execute(interaction, context);

    expect(replyContent(reply)).toContain(text);
  });

  it.each([
    ['pause', pause],
    ['resume', resume],
    ['skip', skip],
    ['stop', stop],
    ['queue', queue],
    ['nowplaying', nowPlaying],
    ['disconnect', disconnect],
    ['volume', volume],
    ['shuffle', shuffle],
    ['loop', loop],
  ])('/%s is guild only', async (_name, command) => {
    const { context } = fakeContext();
    const options = command === loop ? { stringOptions: { mode: 'off' } } : {};
    const { interaction, reply } = fakeChatInput({ guildId: null, ...options });

    await command.execute(interaction, context);

    expect(replyContent(reply)).toContain('inside a server');
  });
});

describe('/pause and /resume', () => {
  it('pauses, refuses to pause twice, then resumes', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));

    const first = fakeChatInput();
    await pause.execute(first.interaction, context);
    expect(replyContent(first.reply)).toBe('Paused.');

    const second = fakeChatInput();
    await pause.execute(second.interaction, context);
    expect(replyContent(second.reply)).toContain('already paused');

    const third = fakeChatInput();
    await resume.execute(third.interaction, context);
    expect(replyContent(third.reply)).toBe('Resumed.');
    expect(player.snapshot().status).toBe('playing');
  });

  it('answers cleanly when nothing is playing', async () => {
    const { context } = contextWithPlayer();
    const { interaction, reply } = fakeChatInput();

    await pause.execute(interaction, context);

    expect(replyContent(reply)).toContain('Nothing is playing');
  });

  it('answers cleanly when the bot is not connected at all', async () => {
    const { context } = fakeContext();
    const { interaction, reply } = fakeChatInput();

    await resume.execute(interaction, context);

    expect(replyContent(reply)).toContain('Nothing is playing');
  });

  it.each([
    ['pause', pause],
    ['resume', resume],
  ])('/%s acknowledges before its serialised player operation', async (_name, command) => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    if (command === resume) {
      await player.pause();
    }
    const call = fakeChatInput();

    await command.execute(call.interaction, context);

    expect(call.deferReply).toHaveBeenCalledTimes(1);
    expect(call.editReply).toHaveBeenCalledTimes(1);
    expect(call.interactionReply).not.toHaveBeenCalled();
  });
});

describe('/skip', () => {
  it('reports the next track', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    const { interaction, reply, deferReply, editReply, interactionReply } = fakeChatInput();

    await skip.execute(interaction, context);

    expect(replyContent(reply)).toBe('Skipped. Now playing **Track b**.');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
    expect(player.current?.sourceId).toBe('b');
  });

  it('reports going idle when the queue is empty', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    const { interaction, reply } = fakeChatInput();

    await skip.execute(interaction, context);

    expect(replyContent(reply)).toBe('Skipped. The queue is empty, so I am idle now.');
    expect(player.current).toBeUndefined();
  });

  it('answers cleanly with nothing playing', async () => {
    const { context } = contextWithPlayer();
    const { interaction, reply } = fakeChatInput();

    await skip.execute(interaction, context);

    expect(replyContent(reply)).toContain('Nothing is playing');
  });

  it('defers before waiting for a slow next-track resolution', async () => {
    let finishSkip:
      | ((result: {
          skipped: ReturnType<typeof localTrack>;
          next: ReturnType<typeof localTrack>;
        }) => void)
      | undefined;
    const skipOperation = vi.fn(
      () =>
        new Promise<{
          skipped: ReturnType<typeof localTrack>;
          next: ReturnType<typeof localTrack>;
        }>((resolve) => {
          finishSkip = resolve;
        }),
    );
    const { context } = fakeContext({ get: vi.fn(() => ({ skip: skipOperation })) });
    const { interaction, reply, deferReply, editReply, interactionReply } = fakeChatInput();

    const execution = skip.execute(interaction, context);
    await vi.waitFor(() => {
      expect(skipOperation).toHaveBeenCalledTimes(1);
    });

    expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      skipOperation.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(reply).not.toHaveBeenCalled();
    expect(interaction.deferred).toBe(true);

    finishSkip?.({ skipped: localTrack('a'), next: localTrack('slow-next') });
    await execution;

    expect(replyContent(reply)).toBe('Skipped. Now playing **Track slow-next**.');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
  });

  it('reports C after unavailable B fails during skip', async () => {
    const { context, player, transport } = contextWithPlayer();
    transport.failFor('b.opus');
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.enqueue(localTrack('c'));
    const { interaction, reply, deferReply, editReply, interactionReply } = fakeChatInput();

    await skip.execute(interaction, context);

    expect(player.current?.sourceId).toBe('c');
    expect(transport.played.map((source) => source.input)).toEqual(['a.opus', 'c.opus']);
    expect(replyContent(reply)).toBe('Skipped. Now playing **Track c**.');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
  });

  it('edits one deferred error response when skip rejects', async () => {
    const { context } = fakeContext({
      get: vi.fn(() => ({ skip: vi.fn().mockRejectedValue(new Error('resolver failed')) })),
    });
    const { interaction, reply, deferReply, editReply, interactionReply } = fakeChatInput();

    await handleInteraction(interaction, createCommandRegistry([skip]), context);

    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(replyContent(reply)).toContain('Something went wrong');
  });
});

describe('/stop', () => {
  it('stops playback, clears the queue and stays connected', async () => {
    const { context, player, players } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    const { interaction, reply, deferReply, editReply, interactionReply } = fakeChatInput();

    await stop.execute(interaction, context);

    expect(replyContent(reply)).toContain('still in the voice channel');
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
    expect(player.snapshot()).toMatchObject({ status: 'idle', upcoming: [] });
    expect(players.destroy).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));

    const first = fakeChatInput();
    await stop.execute(first.interaction, context);
    const second = fakeChatInput();
    await stop.execute(second.interaction, context);

    expect(replyContent(second.reply)).toContain('Nothing to stop');
  });

  it('lets playback start again afterwards', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    const { interaction } = fakeChatInput();
    await stop.execute(interaction, context);

    const result = await player.enqueue(localTrack('b'));

    expect(result.kind).toBe('started');
  });
});

describe('/queue and /nowplaying', () => {
  it('report an empty player', async () => {
    const { context } = fakeContext();
    const queueCall = fakeChatInput();
    const nowCall = fakeChatInput();

    await queue.execute(queueCall.interaction, context);
    await nowPlaying.execute(nowCall.interaction, context);

    expect(replyContent(queueCall.reply)).toContain('queue is empty');
    expect(replyContent(nowCall.reply)).toContain('Nothing is playing');
  });

  it('list the current track and the upcoming ones', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    await player.enqueue(localTrack('b'));
    await player.enqueue(localTrack('c'));
    const { interaction, reply } = fakeChatInput();

    await queue.execute(interaction, context);

    const message = replyContent(reply);
    expect(message).toContain('Track a');
    expect(message).toMatch(/1\. \*\*Track b\*\*/);
    expect(message).toMatch(/2\. \*\*Track c\*\*/);
  });

  it('shows the requester in /nowplaying', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('a', 'user-42'));
    const { interaction, reply } = fakeChatInput();

    await nowPlaying.execute(interaction, context);

    expect(replyContent(reply)).toContain('<@user-42>');
  });
});

describe('/disconnect', () => {
  it('tears the guild session down and confirms', async () => {
    const { context, player, players } = contextWithPlayer();
    await player.enqueue(localTrack('a'));
    const { interaction, reply } = fakeChatInput();

    await disconnect.execute(interaction, context);

    expect(players.destroy).toHaveBeenCalledWith('guild-1');
    expect(replyContent(reply)).toContain('left the voice channel');
    expect(player.current).toBeUndefined();
  });

  it('answers politely when there is nothing to disconnect', async () => {
    const { context, players } = fakeContext();
    const { interaction, reply } = fakeChatInput();

    await disconnect.execute(interaction, context);

    expect(players.destroy).toHaveBeenCalledTimes(1);
    expect(replyContent(reply)).toContain('not connected');
  });
});

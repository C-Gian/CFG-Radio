import type { ChatInputCommandInteraction, Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  createCommandRegistry,
  toApplicationCommands,
  type Command,
} from '../src/discord/command.js';
import { commands } from '../src/discord/commands/index.js';
import { disconnect } from '../src/discord/commands/disconnect.js';
import { ping } from '../src/discord/commands/ping.js';
import { playLocal } from '../src/discord/commands/play-local.js';
import { fakeContext } from './helpers/context.js';

function fakeCommand(name: string): Command {
  return {
    data: { name, toJSON: () => ({ name, description: name }) },
    execute: () => Promise.resolve(),
  };
}

describe('command registry', () => {
  it('ships /ping, /playlocal and /disconnect', () => {
    const registry = createCommandRegistry(commands);

    expect([...registry.keys()].sort()).toEqual(['disconnect', 'ping', 'playlocal']);
    expect(registry.get('ping')).toBe(ping);
    expect(registry.get('playlocal')).toBe(playLocal);
    expect(registry.get('disconnect')).toBe(disconnect);
  });

  it('rejects duplicated command names', () => {
    expect(() => createCommandRegistry([fakeCommand('dup'), fakeCommand('dup')])).toThrow(
      /Duplicate command name: dup/,
    );
  });

  it('serialises every command for the Discord REST API', () => {
    const payload = toApplicationCommands(commands);

    expect(payload).toHaveLength(commands.length);
    expect(payload.map((command) => command.name).sort()).toEqual([
      'disconnect',
      'ping',
      'playlocal',
    ]);
    expect(payload.every((command) => command.description.length > 0)).toBe(true);
  });
});

describe('/ping', () => {
  it('is named "ping" and has a description', () => {
    const json = ping.data.toJSON();

    expect(json.name).toBe('ping');
    expect(json.description).toBeTruthy();
  });

  it('replies with Pong!', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await ping.execute(interaction, fakeContext().context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ content: 'Pong!' });
  });
});

/** Content of the Nth reply, without leaking `any` into the assertions. */
function replyContent(reply: ReturnType<typeof vi.fn>, index = 0): string {
  const payload = reply.mock.calls[index]?.[0] as { content?: string } | undefined;
  return payload?.content ?? '';
}

function fakeGuildInteraction(guildId: string | null) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    reply,
    guild: guildId === null ? null : ({ id: guildId } as unknown as Guild),
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply };
}

describe('/disconnect', () => {
  it('tears the guild session down and confirms', async () => {
    const { context, voice } = fakeContext({ destroy: vi.fn().mockReturnValue(true) });
    const { interaction, reply } = fakeGuildInteraction('guild-1');

    await disconnect.execute(interaction, context);

    expect(voice.destroy).toHaveBeenCalledWith('guild-1');
    expect(replyContent(reply)).toContain('left the voice channel');
  });

  it('answers politely when there is nothing to disconnect', async () => {
    const { context, voice } = fakeContext({ destroy: vi.fn().mockReturnValue(false) });
    const { interaction, reply } = fakeGuildInteraction('guild-1');

    await disconnect.execute(interaction, context);

    expect(voice.destroy).toHaveBeenCalledTimes(1);
    expect(replyContent(reply)).toContain('not connected');
  });

  it('is guild only', async () => {
    const { context, voice } = fakeContext();
    const { interaction, reply } = fakeGuildInteraction(null);

    await disconnect.execute(interaction, context);

    expect(voice.destroy).not.toHaveBeenCalled();
    expect(replyContent(reply)).toContain('inside a server');
  });

  it('stays safe when run twice in a row', async () => {
    const destroy = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { context } = fakeContext({ destroy });
    const { interaction, reply } = fakeGuildInteraction('guild-1');

    await disconnect.execute(interaction, context);
    await disconnect.execute(interaction, context);

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(replyContent(reply, 1)).toContain('not connected');
  });
});

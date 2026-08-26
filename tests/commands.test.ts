import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  createCommandRegistry,
  toApplicationCommands,
  type Command,
} from '../src/discord/command.js';
import { commands } from '../src/discord/commands/index.js';
import { ping } from '../src/discord/commands/ping.js';

function fakeCommand(name: string): Command {
  return {
    data: { name, toJSON: () => ({ name, description: name }) },
    execute: () => Promise.resolve(),
  };
}

describe('command registry', () => {
  it('indexes the shipped commands by name', () => {
    const registry = createCommandRegistry(commands);

    expect([...registry.keys()]).toEqual(['ping']);
    expect(registry.get('ping')).toBe(ping);
  });

  it('rejects duplicated command names', () => {
    expect(() => createCommandRegistry([fakeCommand('dup'), fakeCommand('dup')])).toThrow(
      /Duplicate command name: dup/,
    );
  });

  it('serialises every command for the Discord REST API', () => {
    const payload = toApplicationCommands(commands);

    expect(payload).toHaveLength(commands.length);
    expect(payload[0]?.name).toBe('ping');
    expect(payload[0]?.description).toBeTruthy();
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

    await ping.execute(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ content: 'Pong!' });
  });
});

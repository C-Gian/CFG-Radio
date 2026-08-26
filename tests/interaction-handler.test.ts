import type { Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import { createCommandRegistry, type Command } from '../src/discord/command.js';
import { handleInteraction } from '../src/discord/interaction-handler.js';
import { fakeContext } from './helpers/context.js';

interface FakeInteractionOptions {
  chatInput?: boolean;
  commandName?: string;
  replied?: boolean;
  deferred?: boolean;
  reply?: ReturnType<typeof vi.fn>;
  editReply?: ReturnType<typeof vi.fn>;
}

function fakeInteraction(options: FakeInteractionOptions = {}) {
  const reply = options.reply ?? vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const editReply = options.editReply ?? vi.fn().mockResolvedValue(undefined);
  const interaction = {
    isChatInputCommand: () => options.chatInput ?? true,
    commandName: options.commandName ?? 'ping',
    replied: options.replied ?? false,
    deferred: options.deferred ?? false,
    reply,
    followUp,
    editReply,
  };
  return { interaction: interaction as unknown as Interaction, reply, followUp, editReply };
}

function commandThat(execute: Command['execute'], name = 'ping'): Command {
  return { data: { name, toJSON: () => ({ name, description: name }) }, execute };
}

const failingCommand = (): Promise<void> => Promise.reject(new Error('boom'));

describe('handleInteraction', () => {
  it('ignores non chat-input interactions', async () => {
    const execute = vi.fn();
    const { interaction, reply } = fakeInteraction({ chatInput: false });

    await handleInteraction(
      interaction,
      createCommandRegistry([commandThat(execute)]),
      fakeContext().context,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('dispatches to the matching command with the command context', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { interaction } = fakeInteraction();
    const { context } = fakeContext();

    await handleInteraction(interaction, createCommandRegistry([commandThat(execute)]), context);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBe(interaction);
    expect(execute.mock.calls[0]?.[1]).toBe(context);
  });

  it('answers and warns when the command is unknown', async () => {
    const { context, logger } = fakeContext();
    const { interaction, reply } = fakeInteraction({ commandName: 'unknown' });

    await handleInteraction(interaction, createCommandRegistry([]), context);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not reject when the command throws, and reports the failure', async () => {
    const { context, logger } = fakeContext();
    const { interaction, reply } = fakeInteraction();

    await expect(
      handleInteraction(interaction, createCommandRegistry([commandThat(failingCommand)]), context),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining('went wrong') as unknown,
    });
  });

  it('follows up instead of replying when the interaction was already answered', async () => {
    const { interaction, reply, followUp } = fakeInteraction({ replied: true });

    await handleInteraction(
      interaction,
      createCommandRegistry([commandThat(failingCommand)]),
      fakeContext().context,
    );

    expect(followUp).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('edits the original response when a deferred command fails', async () => {
    const { interaction, reply, followUp, editReply } = fakeInteraction({ deferred: true });

    await handleInteraction(
      interaction,
      createCommandRegistry([commandThat(failingCommand)]),
      fakeContext().context,
    );

    expect(editReply).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it.each([10062, 40060, '10062', '40060'])(
    'does not retry a terminal Discord interaction error (%s)',
    async (code) => {
      const terminalFailure = (): Promise<void> =>
        Promise.reject(Object.assign(new Error('terminal interaction error'), { code }));
      const { context, logger } = fakeContext();
      const { interaction, reply, followUp, editReply } = fakeInteraction({ deferred: true });

      await handleInteraction(
        interaction,
        createCommandRegistry([commandThat(terminalFailure)]),
        context,
      );

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(reply).not.toHaveBeenCalled();
      expect(editReply).not.toHaveBeenCalled();
      expect(followUp).not.toHaveBeenCalled();
    },
  );

  it('survives a Discord API failure while reporting the error', async () => {
    const { context, logger } = fakeContext();
    const { interaction } = fakeInteraction({
      reply: vi.fn().mockRejectedValue(new Error('unknown interaction')),
    });

    await expect(
      handleInteraction(interaction, createCommandRegistry([commandThat(failingCommand)]), context),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

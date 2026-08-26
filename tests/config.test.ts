import { describe, expect, it } from 'vitest';

import { ConfigError, DEFAULTS, loadConfig } from '../src/config/env.js';

const FAKE_TOKEN = 'fake-token-for-tests';

const validEnv = (): Record<string, string | undefined> => ({
  DISCORD_TOKEN: FAKE_TOKEN,
  DISCORD_CLIENT_ID: '111111111111111111',
  DISCORD_GUILD_ID: '222222222222222222',
});

describe('loadConfig', () => {
  it('accepts an environment with only the required variables and applies defaults', () => {
    const config = loadConfig(validEnv());

    expect(config).toEqual({
      discordToken: FAKE_TOKEN,
      discordClientId: '111111111111111111',
      discordGuildId: '222222222222222222',
      logLevel: DEFAULTS.logLevel,
      defaultVolume: DEFAULTS.defaultVolume,
      idleDisconnectSeconds: DEFAULTS.idleDisconnectSeconds,
    });
  });

  it('reads and normalises the optional variables', () => {
    const config = loadConfig({
      ...validEnv(),
      LOG_LEVEL: ' DEBUG ',
      DEFAULT_VOLUME: '55',
      IDLE_DISCONNECT_SECONDS: '0',
    });

    expect(config.logLevel).toBe('debug');
    expect(config.defaultVolume).toBe(55);
    expect(config.idleDisconnectSeconds).toBe(0);
  });

  it('trims surrounding whitespace of required variables', () => {
    const config = loadConfig({ ...validEnv(), DISCORD_GUILD_ID: '  333  ' });

    expect(config.discordGuildId).toBe('333');
  });

  it('reports every missing required variable at once', () => {
    let thrown: unknown;
    try {
      loadConfig({ DISCORD_TOKEN: '   ' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const issues = (thrown as ConfigError).issues;
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).toContain('DISCORD_TOKEN is required');
    expect(issues.join('\n')).toContain('DISCORD_CLIENT_ID is required');
    expect(issues.join('\n')).toContain('DISCORD_GUILD_ID is required');
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...validEnv(), LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it.each(['abc', '1.5', '-1', '101'])('rejects DEFAULT_VOLUME=%s', (value) => {
    expect(() => loadConfig({ ...validEnv(), DEFAULT_VOLUME: value })).toThrow(ConfigError);
  });

  it('rejects a non-integer idle disconnect delay', () => {
    expect(() => loadConfig({ ...validEnv(), IDLE_DISCONNECT_SECONDS: '10s' })).toThrow(
      ConfigError,
    );
  });

  it('never leaks a value in the error message', () => {
    let message = '';
    try {
      loadConfig({ ...validEnv(), DISCORD_TOKEN: '', DEFAULT_VOLUME: '9001' });
    } catch (error) {
      message = (error as ConfigError).message;
    }

    expect(message).not.toContain('9001');
    expect(message).not.toContain('111111111111111111');
    expect(message).toContain('DISCORD_TOKEN');
  });
});

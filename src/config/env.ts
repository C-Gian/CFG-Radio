import { LOG_LEVELS, type LogLevel } from '../logger.js';

export interface AppConfig {
  readonly discordToken: string;
  readonly discordClientId: string;
  readonly discordGuildId: string;
  readonly logLevel: LogLevel;
  readonly defaultVolume: number;
  readonly idleDisconnectSeconds: number;
}

export const DEFAULTS = {
  logLevel: 'info',
  defaultVolume: 100,
  idleDisconnectSeconds: 300,
} as const satisfies Pick<AppConfig, 'logLevel' | 'defaultVolume' | 'idleDisconnectSeconds'>;

/**
 * Raised when the environment is not usable.
 *
 * Only variable *names* and expectations are reported - never values, so a
 * malformed secret can never leak through a crash message or a log line.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type RawEnv = Record<string, string | undefined>;

function requireString(env: RawEnv, key: string, issues: string[]): string {
  const value = env[key]?.trim();
  if (value === undefined || value === '') {
    issues.push(`${key} is required but missing or empty`);
    return '';
  }
  return value;
}

function optionalInteger(
  env: RawEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(`${key} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function optionalLogLevel(env: RawEnv, issues: string[]): LogLevel {
  const raw = env.LOG_LEVEL?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return DEFAULTS.logLevel;
  }
  const match = LOG_LEVELS.find((level) => level === raw);
  if (match === undefined) {
    issues.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
    return DEFAULTS.logLevel;
  }
  return match;
}

/**
 * Validates the process environment and returns the typed application config.
 *
 * @throws {ConfigError} when a required variable is missing or a value is invalid.
 */
export function loadConfig(env: RawEnv = process.env): AppConfig {
  const issues: string[] = [];

  const config: AppConfig = {
    discordToken: requireString(env, 'DISCORD_TOKEN', issues),
    discordClientId: requireString(env, 'DISCORD_CLIENT_ID', issues),
    discordGuildId: requireString(env, 'DISCORD_GUILD_ID', issues),
    logLevel: optionalLogLevel(env, issues),
    defaultVolume: optionalInteger(env, 'DEFAULT_VOLUME', DEFAULTS.defaultVolume, 0, 100, issues),
    idleDisconnectSeconds: optionalInteger(
      env,
      'IDLE_DISCONNECT_SECONDS',
      DEFAULTS.idleDisconnectSeconds,
      0,
      86_400,
      issues,
    ),
  };

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return config;
}

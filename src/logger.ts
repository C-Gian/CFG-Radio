/**
 * Minimal leveled logger.
 *
 * Anything registered through {@link registerSecret} is scrubbed from every
 * message before it reaches the console, so credentials can never end up in
 * the logs (not even inside an error thrown by a third-party library).
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface Logger {
  error(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  debug(message: string, ...details: unknown[]): void;
}

export interface LogSink {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

const secrets = new Set<string>();

/** Registers a value that must never appear in the logs. */
export function registerSecret(value: string | undefined): void {
  // Very short values would redact harmless text, so they are ignored.
  if (value !== undefined && value.length >= 8) {
    secrets.add(value);
  }
}

/** Test seam: drops every registered secret. */
export function clearSecrets(): void {
  secrets.clear();
}

/** Replaces every registered secret found in `text` with a placeholder. */
export function redact(text: string): string {
  let output = text;
  for (const secret of secrets) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

/** Formats a value for logging, scrubbing every registered secret. */
export function formatForLog(detail: unknown): unknown {
  if (detail instanceof Error) {
    return redact(detail.stack ?? `${detail.name}: ${detail.message}`);
  }
  if (typeof detail === 'string') {
    return redact(detail);
  }
  if (typeof detail !== 'object' || detail === null) {
    return detail;
  }
  try {
    // A throwing/undefined-returning toJSON() is caught below.
    return redact(JSON.stringify(detail));
  } catch {
    return '[unserializable]';
  }
}

export function createLogger(level: LogLevel, sink: LogSink = console): Logger {
  const threshold = LEVEL_PRIORITY[level];

  const log = (logLevel: LogLevel, message: string, details: unknown[]): void => {
    if (LEVEL_PRIORITY[logLevel] > threshold) {
      return;
    }
    const line = `${new Date().toISOString()} [${logLevel.toUpperCase()}] ${redact(message)}`;
    sink[logLevel](line, ...details.map(formatForLog));
  };

  return {
    error: (message, ...details) => {
      log('error', message, details);
    },
    warn: (message, ...details) => {
      log('warn', message, details);
    },
    info: (message, ...details) => {
      log('info', message, details);
    },
    debug: (message, ...details) => {
      log('debug', message, details);
    },
  };
}

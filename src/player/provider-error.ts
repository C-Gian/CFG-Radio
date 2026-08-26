/**
 * Stable, provider-agnostic failure reasons.
 *
 * The player and the command handlers only ever see these codes - never a
 * yt-dlp exit code or a line of its stderr. A new provider maps its own
 * failures onto the same set.
 */
export const PROVIDER_ERROR_CODES = [
  'not_found',
  'unavailable',
  'geo_restricted',
  'login_required',
  'rate_limited',
  'extractor_failed',
  'timeout',
  'unsupported',
  'unknown',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorOptions {
  /** Kept for the logs only: never shown to users. */
  readonly diagnostic?: string;
  readonly cause?: unknown;
}

/** A failure raised while resolving metadata or playable media. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly diagnostic: string | undefined;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.code = code;
    this.diagnostic = options.diagnostic;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** The code of `error`, or `unknown` for anything that is not a provider failure. */
export function providerErrorCode(error: unknown): ProviderErrorCode {
  return isProviderError(error) ? error.code : 'unknown';
}

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSecrets, createLogger, redact, registerSecret } from '../src/logger.js';

function fakeSink() {
  const sink = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  const everythingLogged = (): string =>
    JSON.stringify([
      sink.error.mock.calls,
      sink.warn.mock.calls,
      sink.info.mock.calls,
      sink.debug.mock.calls,
    ]);
  return { sink, everythingLogged };
}

afterEach(() => {
  clearSecrets();
});

describe('createLogger', () => {
  it('filters out messages below the configured level', () => {
    const { sink } = fakeSink();
    const logger = createLogger('warn', sink);

    logger.error('an error');
    logger.warn('a warning');
    logger.info('some info');
    logger.debug('some debug');

    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.debug).not.toHaveBeenCalled();
  });

  it('lets everything through at debug level', () => {
    const { sink } = fakeSink();
    const logger = createLogger('debug', sink);

    logger.debug('visible');

    expect(sink.debug).toHaveBeenCalledTimes(1);
    expect(String(sink.debug.mock.calls[0]?.[0])).toContain('[DEBUG] visible');
  });
});

describe('secret redaction', () => {
  const token = 'MTIzNDU2Nzg5.SUPER.SECRET-TOKEN';

  it('scrubs registered secrets from messages, strings and errors', () => {
    registerSecret(token);
    const { sink, everythingLogged } = fakeSink();
    const logger = createLogger('debug', sink);

    logger.info(`logging in with ${token}`);
    logger.error('failed', new Error(`401 Unauthorized for ${token}`));
    logger.warn('payload', { authorization: token });

    expect(everythingLogged()).not.toContain(token);
    expect(String(sink.info.mock.calls[0]?.[0])).toContain('[REDACTED]');
  });

  it('ignores values too short to be a credential', () => {
    registerSecret('abc');

    expect(redact('abc def')).toBe('abc def');
  });

  it('leaves unrelated text untouched', () => {
    registerSecret(token);

    expect(redact('nothing to hide here')).toBe('nothing to hide here');
  });
});

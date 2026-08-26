import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSecrets, createLogger, redact, redactUrls, registerSecret } from '../src/logger.js';

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

describe('signed URL redaction', () => {
  const SIGNED =
    'https://rr5---sn-abc.googlevideo.com/videoplayback?expire=1&sig=SUPERSECRET&ei=xyz';

  it('keeps host and path but drops the signature', () => {
    const redacted = redactUrls(`FFmpeg: ${SIGNED}: 403 Forbidden`);

    expect(redacted).not.toContain('SUPERSECRET');
    expect(redacted).not.toContain('sig=');
    expect(redacted).toContain('rr5---sn-abc.googlevideo.com/videoplayback');
    expect(redacted).toContain('[redacted]');
    expect(redacted).toContain('403 Forbidden');
  });

  it('redacts SoundCloud CDN policies too', () => {
    const redacted = redactUrls('open https://cf-media.sndcdn.com/a.mp3?Policy=abc&Signature=def');

    expect(redacted).not.toContain('Signature');
    expect(redacted).toContain('cf-media.sndcdn.com/a.mp3');
  });

  it('leaves ordinary text and unsigned links readable', () => {
    expect(redactUrls('nothing to redact here')).toBe('nothing to redact here');
    expect(redactUrls('see https://soundcloud.com/artist/track now')).toBe(
      'see https://soundcloud.com/artist/track now',
    );
  });

  it('reaches every log line, including errors thrown by a library', () => {
    const { sink, everythingLogged } = fakeSink();
    const logger = createLogger('debug', sink);

    logger.warn(`FFmpeg: ${SIGNED}`);
    logger.error('failed', new Error(`could not open ${SIGNED}`));
    logger.info('payload', { url: SIGNED, Cookie: 'sid=abc', Authorization: 'Bearer t' });

    const logged = everythingLogged();
    expect(logged).not.toContain('SUPERSECRET');
    expect(logged).not.toContain('sig=');
    // The useful part survives, so a 403 is still debuggable.
    expect(logged).toContain('googlevideo.com/videoplayback');
  });
});

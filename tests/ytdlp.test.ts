import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { ProviderError, isProviderError } from '../src/player/provider-error.js';
import {
  JS_RUNTIME_ARGS,
  YtDlpRunner,
  classifyYtDlpFailure,
  type YtDlpChild,
} from '../src/youtube/ytdlp.js';
import { fakeLogger } from './helpers/fake-transport.js';

class FakeChild extends EventEmitter implements YtDlpChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  /** Emits output then closes, the way a real process would. */
  finish(stdout: string, code = 0, stderr = ''): void {
    if (stdout !== '') {
      this.stdout.write(stdout);
    }
    if (stderr !== '') {
      this.stderr.write(stderr);
    }
    setImmediate(() => {
      this.emit('close', code);
    });
  }
}

function createRunner(options: { child?: FakeChild; timeoutMs?: number } = {}) {
  let lastCall: { command: string; args: readonly string[] } | undefined;
  const child = options.child ?? new FakeChild();
  const logger = fakeLogger();
  const spawnFn = vi.fn((command: string, args: readonly string[]) => {
    lastCall = { command, args };
    return child;
  });
  const runner = new YtDlpRunner({
    ytdlpPath: 'yt-dlp',
    logger,
    timeoutMs: options.timeoutMs ?? 5_000,
    spawnFn,
  });
  return { runner, child, logger, spawnFn, lastCall: () => lastCall };
}

describe('YtDlpRunner - process handling', () => {
  it('passes arguments as an array, never as a shell string', async () => {
    const { runner, child, spawnFn, lastCall } = createRunner();

    const promise = runner.run(['--version']);
    child.finish('2026.07.04\n');
    await promise;

    expect(spawnFn).toHaveBeenCalledWith('yt-dlp', ['--version']);
    expect(Array.isArray(lastCall()?.args)).toBe(true);
  });

  it('captures stdout and stderr', async () => {
    const { runner, child } = createRunner();

    const promise = runner.run(['--version']);
    child.finish('output\n', 0, 'a warning\n');

    await expect(promise).resolves.toEqual({ stdout: 'output\n', stderr: 'a warning' });
  });

  it('parses JSON output', async () => {
    const { runner, child } = createRunner();

    const promise = runner.json(['--dump-single-json']);
    child.finish('{"id":"abc","title":"Hello"}');

    await expect(promise).resolves.toEqual({ id: 'abc', title: 'Hello' });
  });

  it('classifies malformed JSON instead of throwing a SyntaxError', async () => {
    const { runner, child } = createRunner();

    const promise = runner.json(['--dump-single-json']);
    child.finish('{not json');

    await expect(promise).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'extractor_failed',
    });
  });

  it('rejects empty output', async () => {
    const { runner, child } = createRunner();

    const promise = runner.json(['--dump-single-json']);
    child.finish('   ');

    await expect(promise).rejects.toMatchObject({ code: 'extractor_failed' });
  });

  it('reports a synchronous spawn failure as a provider error', async () => {
    const logger = fakeLogger();
    const runner = new YtDlpRunner({
      ytdlpPath: 'missing-binary',
      logger,
      spawnFn: () => {
        throw new Error('ENOENT');
      },
    });

    await expect(runner.run(['--version'])).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'unknown',
    });
  });

  it('reports an asynchronous spawn error and kills the child', async () => {
    const { runner, child } = createRunner();

    const promise = runner.run(['--version']);
    child.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toMatchObject({ code: 'unknown' });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('times out, kills the process and never leaves it running', async () => {
    const { runner, child, logger } = createRunner({ timeoutMs: 20 });

    const promise = runner.run(['--dump-single-json', 'https://example.test']);

    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('ignores a close that arrives after the timeout (kill stays idempotent)', async () => {
    const { runner, child } = createRunner({ timeoutMs: 20 });

    const promise = runner.run(['--version']);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });

    expect(() => {
      child.finish('late output', 0);
    }).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('maps a non-zero exit onto a classified error and keeps stderr as diagnostic', async () => {
    const { runner, child, logger } = createRunner();

    const promise = runner.run(['--dump-single-json', 'https://example.test']);
    child.finish('', 1, 'ERROR: Video unavailable. This video is no longer available.');

    const error = await promise.catch((caught: unknown) => caught);

    expect(isProviderError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'unavailable' });
    expect((error as ProviderError).diagnostic).toContain('Video unavailable');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('reads the version', async () => {
    const { runner, child } = createRunner();

    const promise = runner.version();
    child.finish('2026.07.04\n');

    await expect(promise).resolves.toBe('2026.07.04');
  });
});

describe('classifyYtDlpFailure', () => {
  it.each([
    ['ERROR: Sign in to confirm your age', 'login_required'],
    ['ERROR: Private video. Sign in if you have been granted access', 'login_required'],
    ['ERROR: Join this channel to get access to members-only content', 'login_required'],
    ['ERROR: The uploader has not made this video available in your country', 'geo_restricted'],
    ['ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests', 'rate_limited'],
    ['ERROR: Sign in to confirm you are not a bot', 'rate_limited'],
    ['ERROR: Video unavailable', 'unavailable'],
    ['ERROR: This video has been removed by the uploader', 'unavailable'],
    ['ERROR: Unable to download webpage: HTTP Error 404: Not Found', 'not_found'],
    ['ERROR: Incomplete YouTube ID abc. URL is probably wrong', 'not_found'],
    ['ERROR: Unsupported URL: https://example.test/video', 'unsupported'],
    ['ERROR: Unable to extract player response', 'extractor_failed'],
    ['ERROR: Requested format is not available', 'extractor_failed'],
    ['something nobody has ever seen', 'extractor_failed'],
  ] as const)('maps %s to %s', (stderr, expected) => {
    expect(classifyYtDlpFailure(stderr)).toBe(expected);
  });
});

describe('JS runtime arguments', () => {
  it('clears the defaults before enabling node', () => {
    // yt-dlp prefers deno when it is enabled, so the defaults must be dropped
    // first for Node to actually be used.
    expect(JS_RUNTIME_ARGS).toEqual(['--no-js-runtimes', '--js-runtimes', 'node']);
    expect(JS_RUNTIME_ARGS.indexOf('--no-js-runtimes')).toBeLessThan(
      JS_RUNTIME_ARGS.indexOf('--js-runtimes'),
    );
  });
});

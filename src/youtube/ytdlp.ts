import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

import { ProviderError, cancelledError, type ProviderErrorCode } from '../player/provider-error.js';
import type { Logger } from '../logger.js';

/** Nothing in the application spawns yt-dlp except this module. */
export const DEFAULT_YTDLP_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on what one extraction may buffer.
 *
 * Playlist extractions already limit their window, but an unexpected payload
 * must never be able to grow the bot out of memory: past this the child is
 * killed and the attempt fails like any other provider error.
 */
export const MAX_YTDLP_OUTPUT_BYTES = 24 * 1024 * 1024;
const MAX_YTDLP_STDERR_BYTES = 256 * 1024;

/**
 * yt-dlp enables `deno` by default and prefers it over every other runtime, so
 * asking for Node means clearing the defaults first. CFG Radio deliberately
 * pins the runtime to the Node it already ships with.
 */
export const JS_RUNTIME_ARGS = ['--no-js-runtimes', '--js-runtimes', 'node'] as const;

/** The slice of `ChildProcess` this module needs; fakes implement it in tests. */
export interface YtDlpChild extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnYtDlp = (command: string, args: readonly string[]) => YtDlpChild;

export interface YtDlpRunnerOptions {
  readonly ytdlpPath: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to `child_process.spawn`. */
  readonly spawnFn?: SpawnYtDlp;
}

export interface YtDlpResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface YtDlpRunOptions {
  /**
   * Cancels this extraction. The child is killed as soon as it aborts, so a
   * /skip never waits for the 30s timeout of an extractor that hangs.
   */
  readonly signal?: AbortSignal;
}

/**
 * Maps yt-dlp diagnostics onto stable domain codes.
 *
 * Order matters: the most specific reasons are checked first. Anything we do
 * not recognise stays `extractor_failed`/`unknown` rather than pretending to
 * know more than we do.
 */
const STDERR_PATTERNS: readonly (readonly [RegExp, ProviderErrorCode])[] = [
  // The bot check says "sign in", but it is a throttle, not a login wall.
  [/confirm (that )?you.{0,4}(re|are)? ?not a bot|not a bot/i, 'rate_limited'],
  [/http error 429|too many requests|rate.?limit/i, 'rate_limited'],
  [
    /sign in to confirm|login required|private video|members-only|join this channel|age.?restricted/i,
    'login_required',
  ],
  [
    /available in your country|blocked it in your country|geo.?restrict|country restriction/i,
    'geo_restricted',
  ],
  [
    /video unavailable|this video is unavailable|has been removed|account associated with this video has been terminated/i,
    'unavailable',
  ],
  [/http error 404|does not exist|incomplete youtube id|video not found/i, 'not_found'],
  [/drm protected|encrypted(?:-| )only/i, 'unsupported'],
  [/unsupported url|is not a valid url|no video formats found/i, 'unsupported'],
  [
    /unable to extract|failed to extract|requested format is not available|nsig|player response/i,
    'extractor_failed',
  ],
];

export function classifyYtDlpFailure(stderr: string): ProviderErrorCode {
  for (const [pattern, code] of STDERR_PATTERNS) {
    if (pattern.test(stderr)) {
      return code;
    }
  }
  return 'extractor_failed';
}

/**
 * Runs yt-dlp as a controlled child process.
 *
 * Guarantees: arguments are always passed as an array (never a shell string),
 * the process is killed on timeout, stdout/stderr are fully captured, and no
 * child is left behind - whatever happens.
 */
export class YtDlpRunner {
  private readonly ytdlpPath: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly spawnFn: SpawnYtDlp;
  private readonly activeRuns = new Set<() => void>();
  private destroyed = false;

  constructor(options: YtDlpRunnerOptions) {
    this.ytdlpPath = options.ytdlpPath;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_YTDLP_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
  }

  /**
   * Runs yt-dlp and resolves with its output.
   *
   * @throws {ProviderError} classified from the exit code and stderr.
   */
  run(args: readonly string[], options: YtDlpRunOptions = {}): Promise<YtDlpResult> {
    if (this.destroyed) {
      return Promise.reject(new ProviderError('unknown', 'yt-dlp runner is shutting down'));
    }
    // Nothing is spawned for an attempt that is already gone.
    if (options.signal?.aborted === true) {
      return Promise.reject(cancelledError('The yt-dlp extraction'));
    }
    return new Promise<YtDlpResult>((resolve, reject) => {
      let child: YtDlpChild;
      try {
        child = this.spawnFn(this.ytdlpPath, args);
      } catch (error) {
        reject(
          new ProviderError('unknown', `Could not start yt-dlp ("${this.ytdlpPath}")`, {
            cause: error,
          }),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let abort = (): void => undefined;
      const onAbort = (): void => {
        abort();
      };

      const finish = (outcome: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.activeRuns.delete(abort);
        options.signal?.removeEventListener('abort', onAbort);
        outcome();
      };

      // Idempotent: killing an already dead process is a no-op.
      const kill = (): void => {
        try {
          child.kill('SIGKILL');
        } catch (error) {
          this.logger.debug('Could not kill the yt-dlp process', error);
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const timer = setTimeout(() => {
        finish(() => {
          kill();
          this.logger.warn(`yt-dlp timed out after ${this.timeoutMs}ms`);
          reject(new ProviderError('timeout', 'yt-dlp did not answer in time'));
        });
      }, this.timeoutMs);
      // Never keep the process alive just for this timer.
      timer.unref();

      abort = (): void => {
        finish(() => {
          kill();
          reject(cancelledError('The yt-dlp extraction'));
        });
      };
      this.activeRuns.add(abort);
      // Late listeners are safe: finish() is exactly-once, so an abort that
      // races the timeout or the close event simply loses.
      options.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_YTDLP_OUTPUT_BYTES) {
          finish(() => {
            kill();
            this.logger.warn(
              `yt-dlp produced more than ${MAX_YTDLP_OUTPUT_BYTES} bytes and was stopped`,
            );
            reject(
              new ProviderError(
                'extractor_failed',
                'yt-dlp returned an unreasonably large payload',
              ),
            );
          });
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        // Diagnostics only: keep the head, never grow without bound.
        const remaining = MAX_YTDLP_STDERR_BYTES - stderr.length;
        if (remaining > 0) {
          stderr += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        }
      });

      child.on('error', (error: unknown) => {
        finish(() => {
          kill();
          reject(
            new ProviderError('unknown', `yt-dlp could not be executed ("${this.ytdlpPath}")`, {
              cause: error,
              diagnostic: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      });

      child.on('close', (code: number | null) => {
        finish(() => {
          const trimmedStderr = stderr.trim();
          if (code === 0) {
            if (trimmedStderr !== '') {
              this.logger.debug(`yt-dlp stderr: ${trimmedStderr}`);
            }
            resolve({ stdout, stderr: trimmedStderr });
            return;
          }

          const classified = classifyYtDlpFailure(trimmedStderr);
          this.logger.warn(
            `yt-dlp exited with code ${code ?? -1} (${classified}): ${firstLine(trimmedStderr)}`,
          );
          reject(
            new ProviderError(classified, `yt-dlp failed with exit code ${code ?? -1}`, {
              diagnostic: trimmedStderr,
            }),
          );
        });
      });
    });
  }

  /**
   * Runs yt-dlp and parses its stdout as JSON.
   *
   * @throws {ProviderError} `extractor_failed` when the output is not usable.
   */
  async json(args: readonly string[], options: YtDlpRunOptions = {}): Promise<unknown> {
    const { stdout } = await this.run(args, options);
    const trimmed = stdout.trim();

    if (trimmed === '') {
      throw new ProviderError('extractor_failed', 'yt-dlp returned no output');
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new ProviderError('extractor_failed', 'yt-dlp returned malformed JSON', {
        cause: error,
        diagnostic: trimmed.slice(0, 200),
      });
    }
  }

  /** `yt-dlp --version`, for the diagnostics script. */
  async version(): Promise<string> {
    const { stdout } = await this.run(['--version']);
    return stdout.trim();
  }

  /** Kills every active extraction and prevents new ones. Idempotent. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    for (const abort of [...this.activeRuns]) {
      abort();
    }
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

function defaultSpawn(command: string, args: readonly string[]): YtDlpChild {
  return nodeSpawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

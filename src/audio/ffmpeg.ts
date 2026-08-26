import { spawn as nodeSpawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

import type { Logger } from '../logger.js';

/**
 * The slice of `ChildProcess` this module relies on.
 *
 * Keeping it structural lets the tests drive the lifecycle with a fake child
 * instead of spawning a real process.
 */
export interface FfmpegChild extends EventEmitter {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFfmpeg = (command: string, args: readonly string[]) => FfmpegChild;

export interface FfmpegPipelineOptions {
  readonly ffmpegPath: string;
  readonly inputPath: string;
  /** Extra input options - headers and reconnection for remote media. */
  readonly inputOptions?: FfmpegInputOptions;
  readonly logger: Logger;
  /** Injected in tests; defaults to `child_process.spawn`. */
  readonly spawnFn?: SpawnFfmpeg;
  /** Called once when FFmpeg dies before {@link FfmpegPipeline.stop} was called. */
  readonly onUnexpectedExit?: (reason: string) => void;
}

export interface FfmpegInputOptions {
  /** HTTP headers to send with the request (remote inputs only). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Enables the HTTP reconnect options; set for remote inputs. */
  readonly remote?: boolean;
}

/** FFmpeg expects one `Name: value` per line, CRLF terminated. */
function headerBlock(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('');
}

/**
 * Builds the FFmpeg command line.
 *
 * Ogg/Opus at 48 kHz stereo is exactly what Discord wants, so FFmpeg's own
 * libopus does the encoding and no native Opus binding is needed on the Node
 * side. Output goes to stdout as a stream; stdin is closed so FFmpeg can never
 * block waiting for console input.
 *
 * The same pipeline serves local files and remote media URLs: only the input
 * options differ (headers and reconnection for HTTP).
 */
export function buildFfmpegArgs(inputPath: string, options: FfmpegInputOptions = {}): string[] {
  const inputOptions: string[] = [];

  if (options.headers !== undefined && Object.keys(options.headers).length > 0) {
    inputOptions.push('-headers', headerBlock(options.headers));
  }

  if (options.remote === true) {
    // A dropped connection mid-track should be retried, not fatal.
    inputOptions.push(
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_on_network_error',
      '1',
      '-reconnect_delay_max',
      '5',
    );
  }

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-nostdin',
    ...inputOptions,
    '-i',
    inputPath,
    // Audio only: any cover art / video stream is dropped.
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-application',
    'audio',
    '-f',
    'opus',
    'pipe:1',
  ];
}

/**
 * One FFmpeg child process turning a local file into an Ogg/Opus stream.
 *
 * The instance owns the process: {@link stop} is idempotent, always kills the
 * child if it is still alive, and a crashing FFmpeg is reported through
 * `onUnexpectedExit` instead of taking the bot down.
 */
export class FfmpegPipeline {
  private readonly child: FfmpegChild;
  private readonly logger: Logger;
  private readonly onUnexpectedExit: ((reason: string) => void) | undefined;
  private stopped = false;
  private exited = false;

  private constructor(child: FfmpegChild, options: FfmpegPipelineOptions) {
    this.child = child;
    this.logger = options.logger;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  /**
   * Spawns FFmpeg for `inputPath`.
   *
   * @throws {Error} if the process cannot be spawned synchronously, or if it
   * was spawned without a usable stdout pipe.
   */
  static start(options: FfmpegPipelineOptions): FfmpegPipeline {
    const spawnFn = options.spawnFn ?? defaultSpawn;
    const args = buildFfmpegArgs(options.inputPath, options.inputOptions ?? {});

    let child: FfmpegChild;
    try {
      child = spawnFn(options.ffmpegPath, args);
    } catch (error) {
      throw new Error(`Failed to spawn FFmpeg ("${options.ffmpegPath}")`, { cause: error });
    }

    if (child.stdout === null) {
      child.kill('SIGKILL');
      throw new Error('FFmpeg was spawned without a stdout pipe');
    }

    const pipeline = new FfmpegPipeline(child, options);
    pipeline.attachListeners();
    return pipeline;
  }

  /** The Ogg/Opus stream. */
  get output(): Readable {
    if (this.child.stdout === null) {
      throw new Error('FFmpeg stdout is not available');
    }
    return this.child.stdout;
  }

  get isRunning(): boolean {
    return !this.exited && !this.stopped;
  }

  /**
   * Terminates FFmpeg and releases its streams.
   *
   * Safe to call any number of times, at any point of the lifecycle.
   */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (!this.exited) {
      this.logger.debug('Stopping the FFmpeg process');
      try {
        this.child.kill('SIGKILL');
      } catch (error) {
        this.logger.warn('Failed to kill the FFmpeg process', error);
      }
    }

    // Frees the pipe even if nothing consumed the stream.
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }

  private attachListeners(): void {
    this.child.stderr?.on('data', (chunk: unknown) => {
      const message = String(chunk).trim();
      if (message !== '') {
        this.logger.warn(`FFmpeg: ${message}`);
      }
    });

    // Emitted when the binary is missing or not executable.
    this.child.on('error', (error: unknown) => {
      this.exited = true;
      this.logger.error('FFmpeg process error', error);
      this.reportUnexpectedExit('FFmpeg could not be started');
    });

    this.child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true;
      const description = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
      this.logger.debug(`FFmpeg exited with ${description}`);

      if (!this.stopped && code !== 0) {
        this.reportUnexpectedExit(`FFmpeg exited with ${description}`);
      }
    });

    // A closed stdout (player stopped reading) must never crash the process.
    this.child.stdout?.on('error', (error: unknown) => {
      this.logger.debug('FFmpeg stdout error', error);
    });
  }

  private reportUnexpectedExit(reason: string): void {
    if (this.stopped) {
      return;
    }
    this.onUnexpectedExit?.(reason);
  }
}

function defaultSpawn(command: string, args: readonly string[]): FfmpegChild {
  return nodeSpawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Drains a pipeline and returns everything FFmpeg produced.
 *
 * Diagnostics and tests only - playback streams into the audio player instead
 * of buffering.
 */
export function collectPipelineOutput(pipeline: FfmpegPipeline): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = pipeline.output;

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });
}

export interface FfmpegProbeResult {
  readonly available: boolean;
  readonly version: string;
  readonly hasLibopus: boolean;
  readonly error?: string;
}

/**
 * Runs `ffmpeg -version` and checks that the build exposes libopus.
 *
 * Diagnostics only: never used on the playback path.
 */
export async function probeFfmpeg(ffmpegPath: string): Promise<FfmpegProbeResult> {
  try {
    const version = await runFfmpeg(ffmpegPath, ['-hide_banner', '-version']);
    const encoders = await runFfmpeg(ffmpegPath, ['-hide_banner', '-encoders']);
    return {
      available: true,
      version: version.split('\n')[0]?.trim() ?? '',
      hasLibopus: encoders.includes('libopus'),
    };
  } catch (error) {
    return {
      available: false,
      version: '',
      hasLibopus: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (output += chunk));
    child.on('error', (error) => {
      reject(new Error(`Cannot run "${ffmpegPath}": ${error.message}`, { cause: error }));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`"${ffmpegPath}" exited with code ${code ?? -1}`));
      }
    });
  });
}

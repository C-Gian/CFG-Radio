import { get as httpsGet } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { EventEmitter } from 'node:events';

/** The slice of `ClientRequest` this module uses; fakes implement it in tests. */
export interface HttpRequestHandle extends EventEmitter {
  setTimeout(ms: number, callback: () => void): unknown;
  destroy(): unknown;
}

/** The slice of `https.get` this module uses. */
export type HttpGet = (
  url: URL,
  options: { headers: Record<string, string> },
  onResponse: (response: IncomingMessage) => void,
) => HttpRequestHandle;

/** A GitHub release redirects to its CDN, so a couple of hops are expected. */
export const MAX_REDIRECTS = 5;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Refuses a response larger than this; the pinned asset is ~39 MB. */
export const MAX_DOWNLOAD_BYTES = 96 * 1024 * 1024;

export class DownloadError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  /** Injected in tests so nothing touches the network. */
  readonly get?: HttpGet;
}

/**
 * Downloads a URL into memory, with a redirect limit, a timeout and a hard
 * size ceiling.
 *
 * Deliberately small: it exists for one pinned, checksummed binary, so it does
 * not need caching, resuming or progress reporting.
 */
export function downloadToBuffer(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const get: HttpGet = options.get ?? httpsGet;

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      outcome();
    };

    const request = (target: string, redirectsLeft: number): void => {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        finish(() => {
          reject(new DownloadError('The download URL is malformed'));
        });
        return;
      }
      if (parsed.protocol !== 'https:') {
        finish(() => {
          reject(new DownloadError('Only https downloads are allowed'));
        });
        return;
      }

      const req = get(
        parsed,
        { headers: { 'user-agent': 'cfg-radio-setup' } },
        (response: IncomingMessage) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location;

          if (status >= 300 && status < 400 && location !== undefined) {
            response.resume();
            if (redirectsLeft <= 0) {
              finish(() => {
                reject(new DownloadError(`Too many redirects (limit ${maxRedirects})`));
              });
              return;
            }
            request(new URL(location, parsed).toString(), redirectsLeft - 1);
            return;
          }

          if (status !== 200) {
            response.resume();
            finish(() => {
              reject(new DownloadError(`Download failed with HTTP ${status}`));
            });
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > maxBytes) {
              response.destroy();
              finish(() => {
                reject(new DownloadError(`Download exceeded ${maxBytes} bytes`));
              });
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            finish(() => {
              resolve(Buffer.concat(chunks));
            });
          });
          response.on('error', (error) => {
            finish(() => {
              reject(new DownloadError('The download stream failed', { cause: error }));
            });
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(() => {
          reject(new DownloadError(`Download timed out after ${timeoutMs}ms`));
        });
      });
      req.on('error', (error) => {
        finish(() => {
          reject(new DownloadError('The download request failed', { cause: error }));
        });
      });
    };

    request(url, maxRedirects);
  });
}

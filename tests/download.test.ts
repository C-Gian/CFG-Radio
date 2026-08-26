import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { DownloadError, downloadToBuffer, type HttpGet } from '../src/setup/download.js';

class FakeRequest extends EventEmitter {
  timeoutCallback: (() => void) | undefined;
  readonly destroy = vi.fn();

  setTimeout(_ms: number, callback: () => void): this {
    this.timeoutCallback = callback;
    return this;
  }
}

interface FakeResponseSpec {
  status?: number;
  location?: string;
  body?: string | Buffer | undefined;
  /** Emitted instead of data, to simulate a broken stream. */
  error?: Error;
}

/** Builds a fake https.get that answers each call from `script`. */
function fakeTransport(script: FakeResponseSpec[]) {
  const requests: FakeRequest[] = [];
  const urls: string[] = [];
  const get: HttpGet = (url, _options, onResponse) => {
    urls.push(url.toString());
    const request = new FakeRequest();
    requests.push(request);
    const spec = script[requests.length - 1] ?? { status: 200, body: '' };

    setImmediate(() => {
      const response = new PassThrough() as unknown as IncomingMessage & PassThrough;
      Object.defineProperty(response, 'statusCode', { value: spec.status ?? 200 });
      Object.defineProperty(response, 'headers', {
        value: spec.location === undefined ? {} : { location: spec.location },
      });
      onResponse(response);
      if (spec.error !== undefined) {
        response.emit('error', spec.error);
        return;
      }
      if (spec.body !== undefined) {
        response.write(spec.body);
      }
      response.end();
    });
    return request;
  };
  return { get, requests, urls };
}

describe('downloadToBuffer', () => {
  it('returns the body of a 200 response', async () => {
    const { get } = fakeTransport([{ status: 200, body: 'binary-bytes' }]);

    const result = await downloadToBuffer('https://example.test/asset', { get });

    expect(result.toString()).toBe('binary-bytes');
  });

  it('follows redirects up to the limit', async () => {
    const { get, urls } = fakeTransport([
      { status: 302, location: 'https://cdn.example.test/hop1' },
      { status: 302, location: 'https://cdn.example.test/hop2' },
      { status: 200, body: 'payload' },
    ]);

    const result = await downloadToBuffer('https://example.test/asset', { get });

    expect(result.toString()).toBe('payload');
    expect(urls).toEqual([
      'https://example.test/asset',
      'https://cdn.example.test/hop1',
      'https://cdn.example.test/hop2',
    ]);
  });

  it('refuses to follow more redirects than allowed', async () => {
    const { get, urls } = fakeTransport(
      Array.from({ length: 10 }, () => ({ status: 302, location: 'https://example.test/next' })),
    );

    await expect(
      downloadToBuffer('https://example.test/asset', { get, maxRedirects: 2 }),
    ).rejects.toThrow(/Too many redirects/);
    // Original request plus the two allowed hops.
    expect(urls).toHaveLength(3);
  });

  it('rejects a non-200 response', async () => {
    const { get } = fakeTransport([{ status: 404 }]);

    await expect(downloadToBuffer('https://example.test/asset', { get })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('stops a response that exceeds the size ceiling', async () => {
    const { get } = fakeTransport([{ status: 200, body: 'x'.repeat(5_000) }]);

    await expect(
      downloadToBuffer('https://example.test/asset', { get, maxBytes: 1_000 }),
    ).rejects.toThrow(/exceeded 1000 bytes/);
  });

  it('times out and destroys the request', async () => {
    const { get, requests } = fakeTransport([{ status: 200, body: undefined }]);
    // A response that never ends: the timeout is the only way out.
    const pending = downloadToBuffer('https://example.test/asset', { get, timeoutMs: 50 });
    await vi.waitFor(() => {
      expect(requests[0]?.timeoutCallback).toBeDefined();
    });
    requests[0]?.timeoutCallback?.();

    await expect(pending).rejects.toThrow(/timed out after 50ms/);
    expect(requests[0]?.destroy).toHaveBeenCalled();
  });

  it('reports a transport error', async () => {
    const { get, requests } = fakeTransport([{ status: 200 }]);
    const pending = downloadToBuffer('https://example.test/asset', { get });
    requests[0]?.emit('error', new Error('ECONNRESET'));

    await expect(pending).rejects.toThrow(DownloadError);
  });

  it('reports a broken response stream', async () => {
    const { get } = fakeTransport([{ status: 200, error: new Error('stream died') }]);

    await expect(downloadToBuffer('https://example.test/asset', { get })).rejects.toThrow(
      /download stream failed/,
    );
  });

  it.each([
    ['http://example.test/asset', /Only https/],
    ['ftp://example.test/asset', /Only https/],
    ['not-a-url', /malformed/],
  ])('refuses %s without opening a connection', async (url, expected) => {
    const { get, requests } = fakeTransport([]);

    await expect(downloadToBuffer(url, { get })).rejects.toThrow(expected);
    expect(requests).toHaveLength(0);
  });

  it('settles only once when a timeout races the response', async () => {
    const { get, requests } = fakeTransport([{ status: 200, body: 'payload' }]);
    const pending = downloadToBuffer('https://example.test/asset', { get, timeoutMs: 5_000 });

    const result = await pending;
    // A late timeout must not turn a completed download into a failure.
    expect(() => requests[0]?.timeoutCallback?.()).not.toThrow();
    expect(result.toString()).toBe('payload');
  });
});

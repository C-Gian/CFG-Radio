import { describe, expect, it } from 'vitest';

import { canonicalWatchUrl, classifyInput } from '../src/youtube/url.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('classifyInput - supported videos', () => {
  it.each([
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com/watch?v=${VIDEO_ID}`,
    `http://www.youtube.com/watch?v=${VIDEO_ID}`,
    `https://m.youtube.com/watch?v=${VIDEO_ID}`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtu.be/${VIDEO_ID}`,
    `  https://youtu.be/${VIDEO_ID}  `,
    `https://WWW.YouTube.com/watch?v=${VIDEO_ID}`,
  ])('accepts %s', (input) => {
    expect(classifyInput(input)).toEqual({
      kind: 'youtube-video',
      videoId: VIDEO_ID,
      canonicalUrl: canonicalWatchUrl(VIDEO_ID),
    });
  });

  it('keeps the video and ignores extra query parameters', () => {
    const result = classifyInput(`https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s&feature=share`);

    expect(result).toMatchObject({ kind: 'youtube-video', videoId: VIDEO_ID });
  });

  it('treats watch?v=...&list=... as the single video (yt-dlp gets --no-playlist)', () => {
    const result = classifyInput(
      `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PLabcdefghijklmnop&index=3`,
    );

    expect(result).toEqual({
      kind: 'youtube-video',
      videoId: VIDEO_ID,
      canonicalUrl: canonicalWatchUrl(VIDEO_ID),
    });
  });

  it('normalises to a canonical watch URL', () => {
    const result = classifyInput(`https://youtu.be/${VIDEO_ID}?t=30`);

    expect(result).toMatchObject({ canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
  });
});

describe('classifyInput - rejected input', () => {
  it.each([
    ['https://www.youtube.com/playlist?list=PLabcdefghijklmnop', 'playlist'],
    ['https://youtube.com/watch?list=PLabcdefghijklmnop', 'playlist'],
    ['https://www.youtube.com/results?search_query=lofi', 'search'],
    ['never gonna give you up', 'search'],
    ['', 'malformed'],
  ] as const)('rejects %s as %s', (input, reason) => {
    expect(classifyInput(input)).toEqual({ kind: 'unsupported', reason });
  });

  it.each([
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com.attacker.test/watch?v=dQw4w9WgXcQ',
    'https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ',
    'https://soundcloud.com/artist/track',
  ])('refuses the lookalike host %s', (input) => {
    expect(classifyInput(input)).toEqual({ kind: 'unsupported', reason: 'not-youtube' });
  });

  it.each([
    'file:///C:/secret.txt',
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
  ])('refuses the unsupported protocol %s', (input) => {
    expect(classifyInput(input)).toMatchObject({ kind: 'unsupported' });
  });

  it.each([
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/watch?v=way-too-long-video-id',
    'https://youtu.be/short',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/',
    'https://youtu.be/',
  ])('refuses the malformed video reference %s', (input) => {
    expect(classifyInput(input)).toEqual({ kind: 'unsupported', reason: 'malformed' });
  });

  it('never throws on garbage input', () => {
    expect(() => classifyInput('http://[::1')).not.toThrow();
    expect(classifyInput('http://[::1')).toMatchObject({ kind: 'unsupported' });
  });
});

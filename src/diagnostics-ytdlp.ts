import 'dotenv/config';

import { ytdlpPathFromEnv } from './config/env.js';
import { createLogger } from './logger.js';
import { isProviderError } from './player/provider-error.js';
import { JS_RUNTIME_ARGS, YtDlpRunner } from './youtube/ytdlp.js';
import { classifyInput } from './youtube/url.js';

/**
 * yt-dlp readiness check: executable, version, the Node JS runtime and the
 * wrapper itself.
 *
 * Everything here is local - no video is contacted, so the script cannot fail
 * because of an upstream YouTube hiccup. Pass a video URL as an argument to
 * additionally try a real metadata resolution.
 */
async function main(): Promise<void> {
  const logger = createLogger('info');
  const ytdlpPath = ytdlpPathFromEnv();
  const runner = new YtDlpRunner({ ytdlpPath, logger, timeoutMs: 30_000 });
  const failures: string[] = [];

  console.log('=== yt-dlp ===');
  console.log(`  executable: ${ytdlpPath}`);

  let version = '';
  try {
    version = await runner.version();
    console.log(`  version: ${version}`);
  } catch (error) {
    console.log('  version: NOT AVAILABLE');
    failures.push(
      isProviderError(error)
        ? `yt-dlp is not runnable (${error.code}): ${error.message}`
        : String(error),
    );
  }

  if (version !== '') {
    console.log('=== JavaScript runtime (EJS challenges) ===');
    console.log(`  arguments: ${JS_RUNTIME_ARGS.join(' ')}`);
    // yt-dlp reports the runtimes it resolved in its verbose debug block. The
    // bogus input below makes it stop before any network request, so this
    // check stays local.
    const probe = await runner
      .run([...JS_RUNTIME_ARGS, '--verbose', '--simulate', 'cfg-radio-runtime-probe'])
      .then((result) => result.stderr)
      .catch((error: unknown) => (isProviderError(error) ? (error.diagnostic ?? '') : ''));

    const reported = /^\[debug\] JS runtimes: (.+)$/m.exec(probe)?.[1]?.trim() ?? '';
    const usesNode = /(^|[\s,])node-/.test(reported);

    console.log(`  resolved runtimes: ${reported === '' ? '(none reported)' : reported}`);
    console.log(`  node in use: ${usesNode ? 'yes' : 'NO'}`);
    console.log(`  this process: node ${process.versions.node}`);
    if (!usesNode) {
      failures.push('yt-dlp did not resolve the Node JavaScript runtime');
    }
  }

  console.log('=== Wrapper ===');
  try {
    await runner.json(['--dump-json', 'definitely not a url']);
    console.log('  error classification: NO (an invalid input was accepted)');
    failures.push('The wrapper did not reject an invalid input');
  } catch (error) {
    if (isProviderError(error)) {
      console.log(`  error classification: yes (${error.code})`);
    } else {
      console.log('  error classification: NO (unclassified error)');
      failures.push('The wrapper raised an unclassified error');
    }
  }

  const timeoutRunner = new YtDlpRunner({ ytdlpPath, logger, timeoutMs: 1 });
  try {
    await timeoutRunner.version();
    console.log('  timeout handling: not exercised (yt-dlp answered within 1ms)');
  } catch (error) {
    const code = isProviderError(error) ? error.code : 'unknown';
    console.log(`  timeout handling: yes (${code})`);
  }

  const target = process.argv[2];
  if (target !== undefined) {
    console.log('=== Live metadata resolution ===');
    const classified = classifyInput(target);
    if (classified.kind === 'unsupported') {
      console.log(`  input: unsupported (${classified.reason})`);
      failures.push(`The given input is not a supported YouTube video (${classified.reason})`);
    } else {
      try {
        const { fetchYouTubeMetadata } = await import('./youtube/metadata.js');
        const metadata = await fetchYouTubeMetadata(
          runner,
          classified.canonicalUrl,
          classified.videoId,
        );
        console.log(`  id: ${metadata.videoId}`);
        console.log(`  title: ${metadata.title}`);
        console.log(`  uploader: ${metadata.uploader ?? '(unknown)'}`);
        console.log(`  duration: ${metadata.durationMs ?? '(unknown)'}ms`);
      } catch (error) {
        const code = isProviderError(error) ? error.code : 'unknown';
        console.log(`  metadata: FAILED (${code})`);
        failures.push(`Live metadata resolution failed (${code})`);
      }
    }
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`yt-dlp diagnostics FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('yt-dlp diagnostics OK.');
}

try {
  await main();
} catch (error) {
  console.error('[FATAL] yt-dlp diagnostics crashed', error);
  process.exit(1);
}

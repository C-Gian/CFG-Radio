/**
 * A stand-in for yt-dlp, used by the hardening diagnostic and its tests.
 *
 * Plain Node, so it behaves the same on Windows and Linux and needs no shell.
 *
 * Usage: node tools/fake-extractor.mjs <mode> [argument]
 *   hang                 never exits, never writes (simulates a wedged extractor)
 *   sleep <ms>           exits 0 after <ms>
 *   json <text>          writes <text> to stdout and exits 0
 *   flood <bytes>        writes at least <bytes> to stdout, then keeps going
 *   fail <code> <text>   writes <text> to stderr and exits with <code>
 */
const [mode = 'hang', first, second] = process.argv.slice(2);

// Keeps the process alive without burning CPU while it "hangs".
const keepAlive = () => setInterval(() => undefined, 1_000);

switch (mode) {
  case 'hang': {
    keepAlive();
    break;
  }
  case 'sleep': {
    setTimeout(() => process.exit(0), Number(first ?? 1_000));
    break;
  }
  case 'json': {
    process.stdout.write(first ?? '{}');
    process.exit(0);
    break;
  }
  case 'flood': {
    const target = Number(first ?? 1_000_000);
    const chunk = 'x'.repeat(64 * 1024);
    let written = 0;
    const pump = () => {
      while (written < target * 2) {
        written += chunk.length;
        if (!process.stdout.write(chunk)) {
          process.stdout.once('drain', pump);
          return;
        }
      }
      keepAlive();
    };
    pump();
    break;
  }
  case 'fail': {
    process.stderr.write(second ?? 'ERROR: simulated failure');
    process.exit(Number(first ?? 1));
    break;
  }
  default: {
    process.stderr.write(`unknown mode: ${mode}`);
    process.exit(2);
  }
}

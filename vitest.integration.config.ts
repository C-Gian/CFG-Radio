import { defineConfig } from 'vitest/config';

/**
 * Integration suite: really spawns yt-dlp and talks to external providers.
 *
 * Kept out of `npm test` on purpose - an upstream outage must never turn the
 * normal suite red. Run it with `npm run test:integration`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

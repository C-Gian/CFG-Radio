import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The yt-dlp/YouTube suite runs separately: see vitest.integration.config.ts.
    exclude: ['tests/integration/**'],
  },
});

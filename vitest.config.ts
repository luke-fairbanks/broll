import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000, // integration tests run real ffmpeg encodes
    hookTimeout: 60_000,
    pool: 'forks',
  },
});

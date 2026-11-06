import { defineConfig } from 'vitest/config';

/** `npm run perf`: the speed targets (NFR-03). Slow, so separate from `npm test`. */
export default defineConfig({
  test: {
    include: ['packages/api/perf/**/*.perf.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});

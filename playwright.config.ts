import { defineConfig } from '@playwright/test';

/**
 * Critical journeys in a real browser (Stage 2 §12.1, §12.3), on desktop and at 360 px.
 * Run with `npm run e2e`, with `npm run dev:all` stopped. It uses the installed Chrome.
 */
export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: './.pgdata/e2e-results',
  // One dev server compiles each page on first use, so journeys run one at a time.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    channel: 'chrome',
    timezoneId: 'Europe/Sofia',
    locale: 'en-GB',
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    // The phone run also covers the dark theme, so both themes get the contrast checks.
    { name: 'phone', use: { viewport: { width: 360, height: 780 }, colorScheme: 'dark' } },
  ],
  webServer: {
    command: 'node scripts/e2e-server.ts',
    url: 'http://localhost:3100/sign-in',
    timeout: 240_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});

import { defineConfig } from '@playwright/test';

// SVT FE runs on 3001 in dev; backend on 4000. We assume both are already up
// when this is invoked — Playwright does NOT spin them up to keep the smoke
// loop snappy. Override with E2E_BASE_URL to target a different host.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  reporter: 'list',
});

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  forbidOnly: true,
  reporter: 'list',
  use: { headless: true },
});

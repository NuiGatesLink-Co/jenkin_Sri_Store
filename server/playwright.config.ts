import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'reports/playwright-junit.xml' }],
    ['list']
  ],
  use: {
    trace: 'on-first-retry',
  },
});

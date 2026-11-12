import { defineConfig } from '@playwright/test';

// Screen tests: start the built program with the invented test saves and look at it.
export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  workers: 1,
  reporter: 'line',
});

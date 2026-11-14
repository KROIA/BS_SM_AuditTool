import { defineConfig } from '@playwright/test';

// Screen tests: start the built program with the invented test saves and look at it.
// Every launch passes process.env on: the windows open without taking the keyboard from whoever is typing elsewhere.
process.env.AUDIT_TOOL_BACKGROUND = '1';

export default defineConfig({
  testDir: 'test/ui',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  workers: 1,
  reporter: 'line',
});

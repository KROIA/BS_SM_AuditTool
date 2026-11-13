import { defineConfig } from '@playwright/test';

// The packaged program (npm run dist first): the portable zip, unpacked outside the repo and started without Node.
// Not part of test:ui. Run with npm run test:release.
export default defineConfig({
  testDir: 'test/release',
  testMatch: '*.spec.ts',
  outputDir: 'test-results/release',
  workers: 1,
  timeout: 180_000,
  reporter: 'line',
});

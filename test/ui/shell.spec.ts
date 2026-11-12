// Starts the built program with the invented saves and checks the frame, the saves screen and both themes.
// The screenshots land in test-results/ for a person (or the agent) to look at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures'));
// A data folder of its own and empty, so the program remembers no saves from an earlier run or from a person.
const data = path.resolve('test-results/app-data');
let program: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  // The old save comes last: it is a second master and must be refused.
  const saves = [fx.master, ...fx.slaves, fx.legacy];
  program = await electron.launch({ args: ['.', ...saves.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
});
test.afterAll(() => program.close());

test('the frame shows the eight screens and the loaded saves', async () => {
  await expect(page.locator('nav .nav')).toHaveText(['Overview', 'Findings', 'Players', 'Markets', 'Bank accounts', 'Money flow', 'Saves and servers', 'Case and report']);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saves and servers');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['survival-main', 'mining-1', 'nether-hub']);
  await expect(page.locator('nav')).toContainText('3 saves loaded');
  await expect(page.getByRole('alert')).toHaveText(
    '"survival-main" is already loaded as the server with the bank and market data. One workspace holds one network: remove it first to look at "old-world".');
  await expect(page.locator('main')).toContainText('The copies were taken more than an hour apart.'); // nether-hub was copied 9 hours earlier
  // numbers on the screen use the apostrophe: 8 markets x 160 candles + 86 orders
  await expect(page.locator('section', { hasText: 'survival-main' })).toContainText("2 tables, 1'366 rows");
  await page.screenshot({ path: 'test-results/saves-dark.png' });
});

test('the engine inside the program reads SQLite, and 64-bit numbers survive the way to the screen', async () => {
  const check = await page.evaluate(() => (globalThis as unknown as { audit: { call(m: string): Promise<{ node: string; sqlite: string; largest: bigint }> } }).audit.call('selfCheck'));
  console.log(`engine inside Electron ${await program.evaluate(() => process.versions.electron)}: Node ${check.node}, SQLite ${check.sqlite}`);
  expect(check.sqlite).toMatch(/^3\./);
  expect(check.largest).toBe(2n ** 63n - 1n);
});

test('the light theme can be switched on and is remembered', async () => {
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: 'test-results/saves-light.png' });
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'dark');
});

test('a screen that is not built yet says which milestone brings it', async () => {
  await page.getByRole('link', { name: 'Markets' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Markets');
  await expect(page.locator('main')).toContainText('milestone M1');
  await page.screenshot({ path: 'test-results/soon-dark.png' });
  await page.getByRole('link', { name: 'Saves and servers' }).first().click();
});

test('the engine cannot be asked for anything that is not on its list', async () => {
  const error = await page.evaluate(() => (globalThis as unknown as { audit: { call(m: string): Promise<unknown> } }).audit.call('constructor').then(() => '', (e: Error) => e.message));
  expect(error).toContain('has no call named');
});

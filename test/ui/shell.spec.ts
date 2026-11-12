// Starts the built program with the invented saves and checks the frame, the saves screen and both themes.
// The screenshots land in test-results/ for a person (or the agent) to look at.
// Dropping a folder is not tested: Playwright cannot hand the page a File that carries a real path.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures'));

/** Starts the program on a data folder of its own, so it remembers no saves from a person or from another test. */
async function launch(data: string, open: string[] = [], fresh = true) {
  if (fresh) fs.rmSync(data, { recursive: true, force: true });
  const program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  const page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  return { program, page };
}

test.describe('with nothing loaded', () => {
  let program: ElectronApplication;
  let page: Page;
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-empty'))));
  test.afterAll(() => program.close());

  test('the saves screen is the start screen', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saves and servers');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText('Open a save');
    await expect(page.getByRole('region', { name: 'Drop a save folder here' })).toContainText('never writes to a save');
    await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible();
    await expect(page.locator('nav')).toContainText('No save loaded');
    await expect(page.getByText('What each source covers')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/saves-start-dark.png' });
  });
});

test.describe('with the invented network loaded', () => {
  const data = path.resolve('test-results/app-data');
  let program: ElectronApplication;
  let page: Page;
  // The old save comes last: it is a second master and must be refused.
  test.beforeAll(async () => ({ program, page } = await launch(data, [fx.master, ...fx.slaves, fx.legacy])));
  test.afterAll(() => program.close());

  test('the frame shows the eight screens and the loaded saves', async () => {
    await expect(page.locator('nav .nav')).toHaveText(['Overview', 'Findings', 'Players', 'Markets', 'Bank accounts', 'Money flow', 'Saves and servers', 'Case and report']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saves and servers');
    await expect(page.locator('section.save h2')).toHaveText(['survival-main', 'mining-1', 'nether-hub']);
    await expect(page.locator('nav')).toContainText('3 saves loaded');
    await expect(page.getByRole('alert')).toHaveText(
      '"survival-main" is already loaded as the server with the bank and market data. One workspace holds one network: remove it first to look at "old-world".');
    await expect(page.locator('main')).toContainText('The copies were taken more than an hour apart.'); // nether-hub was copied 9 hours earlier
    const master = page.locator('section', { hasText: 'survival-main' }).first();
    // numbers on the screen use the apostrophe: 8 markets x 160 candles + 86 orders
    await expect(master).toContainText("2 tables, 1'366 rows");
    await expect(master).toContainText('Master');
    await expect(master).toContainText('Copy taken 4 Nov 2026');
    await expect(master).toContainText('BankSystem 2.2.0 · Minecraft 1.21.1');
    await expect(page.locator('section', { hasText: 'mining-1' }).first()).toContainText('Slaves keep no bank or market data.');
    await expect(page.locator('[aria-busy]')).toHaveCount(0);
  });

  test('the coverage shows one row per source on one time axis', async () => {
    const rows = page.locator('.crow:not([aria-hidden])');
    await expect(rows.locator('.clabel')).toHaveText(['Bank log', 'Balance snapshots', 'Market orders', 'Market prices',
      'Diagnostics, survival-main', 'Diagnostics, mining-1', 'Diagnostics, nether-hub']);
    // the bank log starts with the starting balances a day before the scenario; the market only has the scenario day
    await expect(rows.nth(0).locator('.cnote')).toHaveText('since 3 Nov 2026');
    await expect(rows.nth(3).locator('.cnote')).toHaveText('since 4 Nov 2026');
    // snapshots: few on the first day (lighter), many on the second
    const snaps = rows.nth(1).locator('.track span');
    await expect(snaps).toHaveCount(2);
    await expect(snaps.nth(0)).not.toHaveCSS('opacity', '1');
    await expect(snaps.nth(1)).toHaveCSS('opacity', '1');
    await expect(page.locator('.ticks span')).toHaveText(['3 Nov 2026', '4 Nov 2026']);
    await page.screenshot({ path: 'test-results/saves-dark.png' });
    // the main area scrolls on its own, so a full-page shot does not reach the coverage card
    await page.locator('section', { hasText: 'What each source covers' }).screenshot({ path: 'test-results/coverage-dark.png' });
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
    await page.locator('section', { hasText: 'What each source covers' }).screenshot({ path: 'test-results/coverage-light.png' });
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
    await expect(page.locator('.app')).toHaveAttribute('data-theme', 'dark');
  });

  test('a screen that is not built yet says which milestone brings it', async () => {
    await page.getByRole('link', { name: 'Money flow' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Money flow');
    await expect(page.locator('main')).toContainText('milestone M4');
    await page.screenshot({ path: 'test-results/soon-dark.png' });
    await page.getByRole('link', { name: 'Saves and servers' }).first().click();
  });

  test('the engine cannot be asked for anything that is not on its list', async () => {
    const error = await page.evaluate(() => (globalThis as unknown as { audit: { call(m: string): Promise<unknown> } }).audit.call('constructor').then(() => '', (e: Error) => e.message));
    expect(error).toContain('has no call named');
  });

  test('a removed save leaves the screen and stays gone after a restart', async () => {
    await page.getByRole('button', { name: 'Remove mining-1' }).click();
    await expect(page.locator('section.save h2')).toHaveText(['survival-main', 'nether-hub']);
    await expect(page.getByText('Diagnostics, mining-1')).toHaveCount(0);
    await program.close();
    ({ program, page } = await launch(data, [], false));
    await expect(page.locator('section.save h2')).toHaveText(['survival-main', 'nether-hub']);
    await expect(page.locator('nav')).toContainText('2 saves loaded');
  });
});

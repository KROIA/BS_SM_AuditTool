// The portable zip of `npm run dist`: unpacked into a fresh folder outside the repo, started with nothing but Windows on
// the PATH, it opens the invented network as folders and as a zip, the engine (a utility process inside app.asar) answers,
// and the Overview shows its known figures. Screenshots land in test-results/.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.ts';
import { folderEntries, writeZip } from '../fixtures/zip.ts';

/** AUDIT_TOOL_EXE: an installed program to check instead of the portable zip (the install check of AT-50). */
const installed = process.env.AUDIT_TOOL_EXE;
const release = path.resolve('release');
const portable = fs.readdirSync(release).find((f) => /-win\.zip$/.test(f));
const fx = buildFixtures(path.resolve('test-results/fixtures-release'));
const network = writeZip(path.resolve('test-results/zips/release-network.zip'), [fx.master, ...fx.slaves].flatMap((s) => folderEntries(s, `network/${path.basename(s)}/`)));
let temp: string; // made in beforeAll: Playwright also loads this file to list the tests
let app: string;
const WINDOWS = 'C:\\Windows\\System32;C:\\Windows';

let program: ElectronApplication;
let page: Page;
async function launch(name: string, open: string[]) {
  const data = path.join(temp, `data-${name}`);
  program = await electron.launch({ executablePath: path.join(app, 'Audit Tool.exe'), args: open.flatMap((s) => ['--open', s]), env: { PATH: WINDOWS, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const figure = (label: string) => page.locator('.figure', { hasText: label }).locator('.fvalue');

test.beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-release-'));
  if (installed) return void (app = path.dirname(installed));
  expect(portable, 'run npm run dist first').toBeTruthy();
  app = path.join(temp, 'app');
  fs.mkdirSync(app);
  const r = spawnSync('C:\\Windows\\System32\\tar.exe', ['-xf', path.join(release, portable!), '-C', app]);
  expect(r.status, String(r.stderr)).toBe(0);
});
test.afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
test.afterEach(() => program?.close());

test('the packaged program opens the network as folders: Overview figures, findings from the engine', async () => {
  await launch('folder', [fx.master, ...fx.slaves]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview', { timeout: 60_000 });
  await expect(page.locator('.sub').first()).toHaveText('survival-main · 1 master and 2 slave servers · 6 players · 11 bank accounts');
  await expect(figure('Players')).toHaveText('6');
  await expect(page.locator('.event')).toHaveCount(8);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // What the packaged program is: its name decides the data folder when AUDIT_TOOL_DATA is not set.
  const where = await program.evaluate(({ app }) => ({ name: app.getName(), packaged: app.isPackaged, appData: app.getPath('appData'), exe: app.getPath('exe') }));
  console.log(`packaged ${where.packaged}, name "${where.name}", default data folder ${path.join(where.appData, where.name)}`);
  expect(where).toMatchObject({ name: 'audit-tool', packaged: true });
  expect(where.exe.toLowerCase().startsWith((installed ? app : temp).toLowerCase())).toBe(true);
  await page.screenshot({ path: 'test-results/release-overview-dark.png' });

  await page.evaluate("location.hash = '#/findings'");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Findings');
  await expect(page.locator('main')).toContainText('25 findings in this time range');
  await page.evaluate("location.hash = '#/players'");
  await expect(page.locator('aside .pick')).toHaveCount(6);
  await page.screenshot({ path: 'test-results/release-players-dark.png' });

  // The region scan's worker thread is loaded by URL from inside app.asar.
  await page.evaluate("location.hash = '#/saves/scan'");
  const scan = page.getByRole('region', { name: 'Region scan' });
  await scan.getByRole('button', { name: 'Start the region scan' }).click();
  await expect(scan).toContainText('Every region file was read: 5 files', { timeout: 30_000 });
  await expect(page.locator('.lead')).toHaveText("980'962.00 $ in banknotes should be outside the bank; 839'180.00 $ was found, so 141'782.00 $ was not found.");
  await page.screenshot({ path: 'test-results/release-scan-dark.png' });
});

test('the packaged program opens the network as a zip, with the same Overview', async () => {
  await launch('zip', [network]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview', { timeout: 60_000 });
  await expect(page.locator('.sub').first()).toHaveText('survival-main · 1 master and 2 slave servers · 6 players · 11 bank accounts');
  await expect(figure('Players')).toHaveText('6');
  await expect(page.locator('.event')).toHaveCount(8);
  await page.evaluate("location.hash = '#/saves'");
  await expect(page.locator('section.card.save').first()).toContainText('from release-network.zip');
  await page.screenshot({ path: 'test-results/release-zip-saves-dark.png' });
});

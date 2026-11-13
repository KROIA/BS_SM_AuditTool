// Opening a .zip (DESIGN_SPEC 4.1) in the program: through --open and through the file picker (stubbed in main), the
// unpacking progress, and a restart that does not unpack again. Screenshots land in test-results/.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.ts';
import { folderEntries, writeZip } from '../fixtures/zip.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-zip'));
const network = writeZip(path.resolve('test-results/zips/network.zip'), [fx.master, ...fx.slaves].flatMap((s) => folderEntries(s, `network/${path.basename(s)}/`)));
// 160 MB stored beside the export, so the unpacking lasts long enough to be seen.
const big = writeZip(path.resolve('test-results/zips/export.zip'), [...folderEntries(fx.exported, path.basename(fx.exported) + '/'),
  { name: 'filler.bin', data: Buffer.alloc(160 * 1024 * 1024, 7), method: 0 }]);
let program: ElectronApplication;
let page: Page;

async function launch(data: string, open: string[] = []) {
  program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
}
const unzipJson = (data: string) => {
  const zips = path.join(data, 'workspace', 'zips');
  return path.join(zips, fs.readdirSync(zips)[0]!, 'unzip.json');
};

test('--open with a zip of the network: the Overview loads, the saves go by the zip; a restart does not unpack again', async () => {
  const data = path.resolve('test-results/app-data-zip-open');
  fs.rmSync(data, { recursive: true, force: true });
  await launch(data, [network]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview', { timeout: 60_000 });
  await page.evaluate("location.hash = '#/saves'");
  await expect(page.locator('section.card.save h2')).toHaveText(['mining-1', 'nether-hub', 'survival-main']);
  await expect(page.locator('section.card.save').first()).toHaveAttribute('title', path.join(network, 'network', 'mining-1'));
  await expect(page.locator('section.card.save').first()).toContainText('from network.zip');
  await page.screenshot({ path: 'test-results/zip-saves-dark.png' });
  const stamp = fs.statSync(unzipJson(data)).mtimeMs;
  await program.close();

  const t = Date.now();
  await launch(data);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview', { timeout: 60_000 });
  console.log(`restart with the unpacked zip: ${Date.now() - t} ms`);
  expect(fs.statSync(unzipJson(data)).mtimeMs).toBe(stamp);
  await program.close();
});

test('the file picker opens a zip: progress while unpacking, then the Overview', async () => {
  const data = path.resolve('test-results/app-data-zip-pick');
  fs.rmSync(data, { recursive: true, force: true });
  await launch(data);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Open a save');
  await page.screenshot({ path: 'test-results/zip-start-dark.png' });
  await program.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never; }, big);
  await page.getByRole('button', { name: 'Open zip' }).click();
  const card = page.locator('section.card.save[aria-busy="true"]');
  await expect(card).toContainText(/Unpacking the zip: [\d']+ MB of 16\d MB/);
  await expect(card.getByRole('progressbar', { name: 'Reading export.zip' })).toHaveAttribute('aria-valuenow', /\d+/);
  await card.screenshot({ path: 'test-results/zip-progress-dark.png' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview', { timeout: 60_000 });
  await program.close();
});

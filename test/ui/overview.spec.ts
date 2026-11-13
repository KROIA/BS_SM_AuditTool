// The Overview on the invented network, on the old 2.1.2 save, and on a master copied without its StockMarket folder.
// Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-overview'));

async function launch(data: string, open: string[]) {
  fs.rmSync(data, { recursive: true, force: true });
  const program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  const page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1500 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens by itself once the saves are loaded
  return { program, page };
}
const summary = (page: Page) => page.getByRole('region', { name: 'Summary' });
const figure = (page: Page, label: string) => page.locator('.figure', { hasText: label });

test.describe('the invented network', () => {
  let program: ElectronApplication;
  let page: Page;
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-overview'), [fx.master, ...fx.slaves])));
  test.afterAll(() => program.close());

  test('the summary names the strongest incident, the figures and both lists, dark and light', async () => {
    await expect(page.locator('.sub').first()).toHaveText(/^survival-main · 1 master and 2 slave servers · 6 players · 11 bank accounts$/);
    await expect(summary(page)).toContainText('Needs attention');
    await expect(summary(page).locator('.sentence')).toHaveText(/^Tavrik made \$[\d'.]+M? on the diamond market within \d+ minutes on \d+ Nov 2026\. The incident holds 8 findings, the strongest of them \w+\.$/);
    await expect(summary(page).getByRole('link', { name: 'Open the incident' })).toHaveAttribute('href', /^#\/findings\/hour-profit/);
    await expect(figure(page, 'Open findings').locator('.small')).toHaveText(/critical|high/);
    await expect(figure(page, 'Players').locator('.fvalue')).toHaveText('6');
    await expect(figure(page, 'Money in bank accounts').locator('.fvalue')).toHaveText(/^\$[\d'.]+[MB]$/);
    await expect(page.getByRole('button', { name: 'Total wealth' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.event')).toHaveCount(8);
    await expect(page.locator('.event').first()).toContainText('Tavrik on the diamond market');
    await expect(page.locator('.event').nth(6)).toContainText('Brindle made an admin');
    await expect(page.locator('.event').nth(7)).toContainText('Slave server mining-1 trusted');
    await expect(page.locator('.pair .card').first().locator('.item')).toHaveCount(2); // Tavrik and Quenby made a profit
    await expect(page.locator('.pair .card').nth(1).locator('.item .what > span:first-child')).toHaveText(['Diamond', 'Emerald']);
    await expect(page.locator('.chip').first()).toHaveText(/^\d+ times usual$/);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/overview-dark.png' });
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await page.screenshot({ path: 'test-results/overview-light.png' });
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  });

  test('an event picked on the chart is picked in the list, and the other way round', async () => {
    const mark = (n: number) => page.locator('.plot .mark', { hasText: new RegExp(`^${n}$`) });
    await mark(4).click();
    await expect(mark(4)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.event').nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.event[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.guide')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Open event 4' })).toHaveAttribute('href', /^#\/findings\//);
    await page.locator('.chartcard').screenshot({ path: 'test-results/overview-event-dark.png' });
    await page.locator('.event').nth(1).click();
    await expect(mark(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(mark(4)).toHaveAttribute('aria-pressed', 'false');
    // Total wealth switched off leaves the money line alone.
    await page.getByRole('button', { name: 'Total wealth' }).click();
    await expect(page.locator('.wealth')).toHaveAttribute('d', '');
    await page.getByRole('button', { name: 'Total wealth' }).click();
    await expect(page.locator('.wealth')).not.toHaveAttribute('d', '');
  });

  test('the zoom of the chart becomes the time range of the whole tool', async () => {
    await expect(page.getByRole('button', { name: 'Use as time range' })).toHaveCount(0);
    const box = (await page.locator('.plot').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.9, box.y + 100);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
    await page.getByRole('button', { name: 'Use as time range' }).click();
    await expect(page.getByRole('button', { name: /^Time range: \d+ Nov, \d\d:\d\d to / })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use as time range' })).toHaveCount(0);
    await page.getByRole('button', { name: /^Time range:/ }).click();
    await page.locator('#range-menu').getByRole('button', { name: 'Everything', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Time range: Everything' })).toBeVisible();
  });
});

test.describe('the old 2.1.2 save', () => {
  let program: ElectronApplication;
  let page: Page;
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-overview-legacy'), [fx.legacy])));
  test.afterAll(() => program.close());

  test('the chart says that old snapshots are thinned out, and there is no wealth line', async () => {
    await expect(page.locator('.chartcard')).toContainText('thins out balance snapshots older than a day');
    await expect(page.getByRole('button', { name: 'Total wealth' })).toHaveCount(0);
    await expect(page.locator('.chartcard h2').first()).toHaveText('Money in bank accounts');
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/overview-legacy-dark.png' });
  });
});

test.describe('a master without its market data', () => {
  let program: ElectronApplication;
  let page: Page;
  const copy = path.resolve('test-results/fixtures-overview/no-market');
  test.beforeAll(async () => {
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(fx.master, copy, { recursive: true });
    fs.rmSync(path.join(copy, 'data', 'StockMarket'), { recursive: true, force: true });
    ({ program, page } = await launch(path.resolve('test-results/app-data-overview-no-market'), [copy]));
  });
  test.afterAll(() => program.close());

  test('the summary says so, and the wealth line and both lists are hidden', async () => {
    // Without trades nothing joins into an incident, so the open findings speak instead of "nothing unusual".
    // 8 with the banknote count (AT-35): the copy keeps the master's player files.
    await expect(summary(page).locator('.sentence')).toHaveText(
      'No incident was found, but 8 findings are open in this time range, the strongest critical. The save has no market data, so trading profit, unusual prices and total wealth are not shown.');
    await expect(page.getByRole('button', { name: 'Total wealth' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Highest trading profit' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Markets with unusual prices' })).toHaveCount(0);
    await expect(page.locator('.plot')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await page.screenshot({ path: 'test-results/overview-no-market-light.png' });
  });
});

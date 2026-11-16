// The top bar on the invented network: time range, server filter and search. Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, ITEM, PLAYERS, T0, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-topbar'));
const data = path.resolve('test-results/app-data-topbar');
const TAVRIK = uuidText(PLAYERS.Tavrik.n), BRINDLE = uuidText(PLAYERS.Brindle.n);
const MIN = 60_000;
/** The value of a datetime-local field, in the computer's time zone like the program's. */
const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(0, 16);
let program: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  program = await electron.launch({ args: ['.', ...[fx.master, ...fx.slaves].flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
});
test.afterAll(() => program.close());

const rangeMenu = () => page.locator('#range-menu');
async function range(choice: string) {
  await page.getByRole('button', { name: /^Time range:/ }).click();
  await rangeMenu().getByRole('button', { name: choice, exact: true }).click();
}

test('the time range changes the figures, and "last" counts back from the newest data', async () => {
  await page.evaluate(`location.hash = '#/players/${TAVRIK}'`);
  await expect(page.locator('.fvalue').nth(1)).toHaveText('60');

  await page.getByRole('button', { name: 'Time range: Everything' }).click();
  await expect(rangeMenu()).toBeVisible();
  await expect(rangeMenu()).toContainText('"Last" counts back from the newest data in the saves');
  await rangeMenu().getByLabel('From').fill(local(T0 + 30 * MIN));
  await rangeMenu().getByLabel('To').fill(local(T0 + 50 * MIN));
  await page.screenshot({ path: 'test-results/topbar-range-dark.png' });
  await rangeMenu().getByRole('button', { name: 'Use this range' }).click();
  await expect(rangeMenu()).toBeHidden();
  await expect(page.getByRole('button', { name: /^Time range: \d+ Nov, \d\d:30 to \d+ Nov, \d\d:50$/ })).toBeVisible();
  await expect(page.locator('.fvalue').nth(1)).toHaveText('30'); // the 30 sells of minute 40, not the buys of minute 21

  await range('Last 24 hours');
  await expect(page.getByRole('button', { name: 'Time range: Last 24 hours' })).toBeVisible();
  await expect(page.locator('.fvalue').nth(1)).toHaveText('60'); // the fixtures span 160 minutes
  await range('Everything');
  await expect(page.locator('.fvalue').nth(1)).toHaveText('60');
});

test('"The incident" sets the range to the strongest incident, 30 minutes on each side', async () => {
  await page.getByRole('button', { name: 'Time range: Everything' }).click();
  const choice = rangeMenu().getByRole('button', { name: /^The incident/ });
  await expect(choice).toContainText('Tavrik on the diamond market');
  await page.screenshot({ path: 'test-results/topbar-incident-dark.png' });
  await choice.click();
  await expect(rangeMenu()).toBeHidden();
  await page.getByRole('button', { name: 'Time range: The incident' }).click();
  await expect(rangeMenu().getByLabel('From')).toHaveValue(local(T0 - 30 * MIN)); // the incident runs from T0 to the end of that hour
  await expect(rangeMenu().getByLabel('To')).toHaveValue(local(T0 + 89 * MIN)); // its last millisecond, plus 30 minutes, to the minute
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await rangeMenu().getByRole('button', { name: 'Everything', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Time range: Everything' })).toBeVisible();
});

test('the server filter hides the orders placed elsewhere and says what it does not filter', async () => {
  await page.getByRole('button', { name: 'Server: all servers' }).click();
  await expect(page.locator('#server-menu')).toContainText('Bank and market data exist only once, on the master.');
  await page.locator('#server-menu').getByRole('button', { name: /^mining-1/ }).click();
  await expect(page.locator('.scopenote')).toContainText('Only orders placed on mining-1 are counted: bank and market data exist only once, on the master');
  await expect(page.locator('.fvalue').nth(1)).toHaveText('0');
  await expect(page.locator('.lead')).toHaveText('Tavrik placed no orders in this time range.');
  await page.evaluate(`location.hash = '#/players/${BRINDLE}'`);
  await expect(page.locator('.fvalue').nth(1)).toHaveText('3');
  await page.getByRole('button', { name: 'Server: mining-1' }).click();
  await expect(page.locator('#server-menu')).toBeVisible();
  await page.screenshot({ path: 'test-results/topbar-server-dark.png' });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Server: mining-1' }).click();
  await page.locator('#server-menu').getByRole('button', { name: 'All servers' }).click();
  await expect(page.locator('.scopenote')).toHaveCount(0);
});

test('search finds a player, a market and an order, and Enter opens the first hit', async () => {
  const field = page.getByRole('searchbox', { name: 'Search everything' });
  const results = page.getByRole('region', { name: 'Search results' });
  await page.evaluate("location.hash = '#/saves'");

  await field.fill('brin');
  await expect(results.locator('.group')).toHaveText(['Players', 'Bank accounts']); // the account is named after the player
  await expect(results.locator('.hit').first()).toContainText('Brindle');
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/players/${BRINDLE}$`));
  await expect(results).toHaveCount(0);

  await field.fill('iron ingot');
  await expect(results.locator('.hit').first()).toContainText('Iron ingot');
  await page.screenshot({ path: 'test-results/topbar-search-dark.png' });
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await field.focus();
  await page.screenshot({ path: 'test-results/topbar-search-light.png' });
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await field.focus();
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/markets/${ITEM.iron}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Iron ingot');

  await field.fill('50'); // order 50 is one of Tavrik's diamond sells
  await expect(results.locator('.group')).toHaveText(['Orders']);
  await expect(results.locator('.hit')).toContainText([/Order 50\s*sell by Tavrik, placed/]);
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/players/${TAVRIK}$`));

  await field.fill('nothing-like-this');
  await expect(results).toContainText('Nothing found.');
  await field.press('Escape');
  await expect(results).toHaveCount(0);
});

test('the chart zoom becomes the time range of the whole tool', async () => {
  await page.evaluate("location.hash = '#/markets/2'");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diamond');
  await expect(page.getByRole('button', { name: 'Use as time range' })).toHaveCount(0);
  const box = (await page.locator('.plot').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
  await page.getByRole('button', { name: 'Use as time range' }).click();
  await expect(page.getByRole('button', { name: /^Time range: \d+ Nov, \d\d:\d\d to / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use as time range' })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.screenshot({ path: 'test-results/topbar-markets-dark.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await range('Everything');
  await expect(page.getByRole('button', { name: 'Time range: Everything' })).toBeVisible();
});

test('an incident picked in the top bar narrows every screen to its players and accounts, its time shaded on the charts', async () => {
  await page.evaluate("location.hash = '#/players'");
  const pick = page.locator('aside .pick');
  await expect(pick).toHaveCount(6);
  await page.getByRole('button', { name: 'Incident shown: none, all the data' }).click();
  const menu = page.locator('#focus-menu');
  await expect(menu.getByRole('button', { name: 'None: all the data' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: 'test-results/topbar-focus-menu-dark.png' });
  await menu.getByRole('button', { name: /^Tavrik on the diamond market/ }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: /^Incident shown: Tavrik on the diamond market/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Time range: The incident' })).toBeVisible();
  await expect(pick).toHaveText([/Tavrik/]); // only the incident's player
  await page.evaluate("location.hash = '#/findings'");
  await expect(page.locator('main')).not.toContainText('Brindle');
  await page.evaluate("location.hash = '#/markets/2'");
  await expect(page.locator('path.incident-span')).toHaveAttribute('d', /^M[-\d.]+ 0H/);
  // The incident's market stands out in the list, and its item in the Item flow timeline's item list.
  await expect(page.locator('aside .pick.involved')).toHaveCount(1);
  await expect(page.locator('aside .pick.involved')).toContainText('In the incident');
  await page.screenshot({ path: 'test-results/topbar-focus-dark.png' });
  await page.evaluate("location.hash = '#/flow'");
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Timeline' }).click();
  const items = page.getByRole('group', { name: 'Items on the chart' }).getByRole('button');
  await expect(items.filter({ hasText: /^Diamond$/ })).toHaveClass(/\bhot\b/);
  await expect(items.locator('.ellipsis').filter({ hasText: /^Money/ }).locator('..')).not.toHaveClass(/\bhot\b/);
  await page.getByRole('group', { name: 'Items on the chart' }).screenshot({ path: 'test-results/topbar-focus-items-dark.png' });

  await page.getByRole('button', { name: /^Incident shown: / }).click();
  await menu.getByRole('button', { name: 'None: all the data' }).click();
  await expect(page.getByRole('button', { name: 'Time range: Everything' })).toBeVisible();
  await expect(page.locator('path.incident-span')).toHaveAttribute('d', '');
  await page.evaluate("location.hash = '#/players'");
  await expect(pick).toHaveCount(6);
});

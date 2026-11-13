// The Players screen with the invented network: the list in the suspicion order, one player's figures, findings, chart and
// both tabs, in both themes; the old 2.1.2 save for the bank history's changes without a log entry.
// Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, PLAYERS, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-players'));
const data = path.resolve('test-results/app-data-players');
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

test('the list is sorted by suspicion, then by profit, and the first player opens with their findings', async () => {
  await page.getByRole('link', { name: 'Players', exact: true }).click();
  // Tavrik and Quenby both weigh 12 (one high and four medium, one critical and two medium): profit decides.
  await expect(page.locator('aside .pick .who > span:first-child')).toHaveText(['Tavrik', 'Quenby', 'Ombrelune', 'Brindle', 'Mikko_82', 'AdmiralNoor']);
  await expect(page.locator('aside')).toContainText('most suspicious first');
  await expect(page.locator('aside .count')).toHaveText(['5', '3', '1', '1', '1']);
  await expect(page.locator('aside .count').nth(1)).toHaveAttribute('title', '3 open findings, the highest critical');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tavrik');
  await expect(page.locator('.uuid')).toHaveText('a1b2c3d4-e5f6-4a7b-8c9d-000000000001');
  await expect(page.locator('.lead')).toHaveText('Tavrik made $5.44M trading profit in this time range, on the Diamond market.');
  await expect(page.locator('.fvalue')).toHaveText(['+$5.44M', '60', "$940'830.00", '5']);
  await expect(page.locator('.figure').nth(3)).toContainText(/Open findings\s*5\s*1 high, 4 medium/);
  const flagged = page.getByRole('region', { name: 'What was flagged' }).locator('a.link-row');
  await expect(flagged).toHaveCount(5);
  await expect(flagged.first()).toContainText("$5.44M trading profit within one hour");
  await flagged.first().click();
  await expect(page).toHaveURL(/#\/findings\/hour-profit%3A/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tavrik');
  await expect(page.locator('.facts')).toContainText('Shared account 30, Tavrik and Quenby');
  await expect(page.locator('.chart path.line')).toHaveCount(1);
});

test('the trades tab: profit by market, trading sessions and the latest orders', async () => {
  await expect(page.locator('.market')).toHaveCount(1);
  const sessions = page.locator('.session');
  await expect(sessions).toHaveCount(2);
  await expect(sessions.first()).toContainText(/4 Nov 2026, \d\d:40:00 · Diamond\s*30 orders, 20 ms apart\s*\+\$5\.44M/);
  await expect(sessions.first().locator('.sdot')).toHaveAttribute('style', /var\(--high\)/); // the hour's profit finding lies in it
  await expect(sessions.nth(1)).toContainText(/· Diamond\s*30 orders, 20 ms apart\s*\$0\.00/);
  await expect(page.locator('.market')).toContainText("60 orders, bought for $440'370.00, sold for $5.88M");
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(10);
  await expect(page.locator('main')).toContainText('the latest 10 of 60');
  await expect(rows.first().locator('td')).toHaveText([/^\d+ Nov 2026, \d\d:\d\d:\d\d\.580$/, 'Diamond', 'Sell', 'Market', '100', "$1'960.40", "$196'040.00", 'survival-main']);
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.screenshot({ path: 'test-results/players-dark.png' });
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(rows).toHaveCount(60);
  await page.getByRole('button', { name: 'Show fewer' }).click();
});

test('the bank history tab: the log of the player\'s accounts in words', async () => {
  await page.getByRole('tab', { name: 'Bank history' }).click();
  const entries = page.locator('.entry');
  await expect(entries).toHaveCount(10);
  await expect(entries.first()).toContainText('Transfer');
  await expect(entries.first()).toContainText('Account 11 · to account 24');
  await expect(entries.first()).toContainText("-$1'000'000.00");
  await expect(entries.nth(1)).toContainText("Withdrawal");
  await expect(entries.nth(3)).toContainText('Sold 100 Diamond');
  await expect(entries.nth(3)).toContainText("+$196'040.00");
  await page.screenshot({ path: 'test-results/players-bank-dark.png' });
});

test('a player picked from the list gets an address; sales without a purchase are not profit', async () => {
  await page.getByRole('link', { name: /Mikko_82/ }).click();
  await expect(page).toHaveURL(/#\/players\/a1b2c3d4-e5f6-4a7b-8c9d-000000000004$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mikko_82');
  await expect(page.locator('.lead')).toContainText('made no realised trading profit');
  await expect(page.locator('.lead')).toContainText("Items worth $115.84 were sold that the player had not bought on the market.");
  await expect(page.locator('.figure').first()).toContainText('plus $115.84 sold without a purchase');
  // The bank tab stays picked; an admin's balance change shows from and to
  await page.getByRole('link', { name: /AdmiralNoor/ }).click();
  await expect(page.locator('.entry').first()).toContainText("Set by an admin");
  await expect(page.locator('.entry').first()).toContainText("from $100'000.00 to $75'000.00");
  await expect(page.locator('.entry').first()).toContainText("-$25'000.00");
  await page.getByRole('tab', { name: 'Trades' }).click();
  await expect(page.locator('.empty')).toHaveText('No orders in the selected time range.');
});

test.describe('an old 2.1.2 save', () => {
  let legacy: ElectronApplication;
  let old: Page;
  test.beforeAll(async () => {
    const dir = path.resolve('test-results/app-data-players-legacy');
    fs.rmSync(dir, { recursive: true, force: true });
    legacy = await electron.launch({ args: ['.', '--open', fx.legacy], env: { ...process.env, AUDIT_TOOL_DATA: dir } });
    old = await legacy.firstWindow();
    await old.setViewportSize({ width: 1440, height: 1100 });
    await expect(old.getByRole('heading', { level: 1 })).toHaveText('Overview');
  });
  test.afterAll(() => legacy.close());

  test('the bank history shows the change without a log entry as a dashed row', async () => {
    await old.evaluate(`location.hash = '#/players/${uuidText(PLAYERS.Quenby.n)}'`);
    await expect(old.getByRole('heading', { level: 1 })).toHaveText('Quenby');
    await old.getByRole('tab', { name: 'Bank history' }).click();
    const gap = old.locator('.entry.gap');
    await expect(gap).toHaveCount(1);
    await expect(gap).toContainText(/Balance fell with no log entry\s*Account 7 · Seen between two balance snapshots\s*-\$200'000\.00/);
    await gap.getByRole('link', { name: 'Account 7' }).scrollIntoViewIfNeeded();
    await old.screenshot({ path: 'test-results/players-legacy-bank-dark.png' });
    await gap.getByRole('link', { name: 'Account 7' }).click();
    await expect(old).toHaveURL(/#\/accounts\/7$/);
  });
});

test('the light theme', async () => {
  await page.getByRole('link', { name: /Tavrik/ }).click();
  await expect(page.locator('.lead')).toContainText('Tavrik made');
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await page.screenshot({ path: 'test-results/players-light.png' });
  await page.getByRole('tab', { name: 'Bank history' }).click();
  await page.screenshot({ path: 'test-results/players-bank-light.png' });
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
});

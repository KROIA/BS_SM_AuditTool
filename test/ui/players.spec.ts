// The Players screen with the invented network: the list in the suspicion order, one player's figures, findings, chart and
// both tabs, in both themes; the old 2.1.2 save for the bank history's changes without a log entry.
// Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { addLinkCases, buildFixtures, PLAYERS, uuidText } from '../fixtures/build.ts';

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
  // Tavrik 18 (two high, five medium), Quenby 14 (one critical, three medium), Ombrelune 10, AdmiralNoor 8: the market alerts
  // (SM-316) add one high and one medium for Tavrik and one medium each for Quenby and Ombrelune.
  await expect(page.locator('aside .pick .who > span:first-child')).toHaveText(['Tavrik', 'Quenby', 'Ombrelune', 'AdmiralNoor', 'Brindle', 'Mikko_82']);
  await expect(page.locator('aside')).toContainText('most suspicious first');
  // Transfer findings (fixtures, TRANSFER_CASES): two for AdmiralNoor, one each for Ombrelune, Brindle and Mikko_82.
  await expect(page.locator('aside .count')).toHaveText(['7', '4', '3', '2', '2', '2']);
  await expect(page.locator('aside .count').nth(1)).toHaveAttribute('title', '4 open findings, the highest critical');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tavrik');
  await expect(page.locator('.uuid')).toHaveText('a1b2c3d4-e5f6-4a7b-8c9d-000000000001');
  await expect(page.locator('.lead')).toHaveText('Tavrik made $5.44M trading profit in this time range, on the Diamond market.');
  await expect(page.locator('.fvalue')).toHaveText(['+$5.44M', '60', "$940'830.00", '7']);
  await expect(page.locator('.figure').nth(3)).toContainText(/Open findings\s*7\s*2 high, 5 medium/);
  const flagged = page.getByRole('region', { name: 'What was flagged' }).locator('a.link-row');
  await expect(flagged).toHaveCount(5); // the first five of 7
  await expect(page.getByRole('region', { name: 'What was flagged' }).getByRole('button', { name: 'Show all 7' })).toBeVisible();
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
  // SM-317: a filled order says nothing more; only a cancelled one gets a line under its quantity.
  await expect(rows.first().locator('td')).toHaveText([/^\d+ Nov 2026, \d\d:\d\d:\d\d\.580$/, 'Diamond', 'Sell', 'Market', '100', "$1'960.40", "$196'040.00", 'survival-main']);
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.screenshot({ path: 'test-results/players-dark.png' });
  await page.getByRole('button', { name: 'Show all', exact: true }).click();
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
  // BS-256 and BS-258: a slave's row names its server (the master's rows do not), and where the player stood.
  await expect(entries.first()).not.toContainText('on survival-main');
  await expect(entries.nth(1)).toContainText('on mining-1');
  await expect(entries.nth(2)).toContainText('Account 11 · at the overworld, -230 70 -920');
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

test('orders (SM-317): the limit price, less filled than wanted, and how the order ended', async () => {
  await page.getByRole('link', { name: /Ombrelune/ }).click();
  await page.getByRole('tab', { name: 'Trades' }).click();
  await expect(page.locator('tbody tr').first().locator('td').nth(3)).toHaveText("Limit at $10.00");
  await expect(page.locator('tbody tr').first().locator('td').nth(4)).toHaveText('8 of 16cancelled by the player'); // volumes are in hundredths of an item
  await page.screenshot({ path: 'test-results/players-orders-end-dark.png' });
  await page.getByRole('link', { name: /Mikko_82/ }).click();
  await expect(page.locator('tbody tr').first().locator('td').nth(4)).toContainText('cancelled by the server');
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

  test('connected players: money that appeared without a row is a likely note link (AT-41)', async () => {
    await old.evaluate(`location.hash = '#/players/${uuidText(PLAYERS.Tavrik.n)}'`);
    await old.getByRole('tab', { name: /^Connected players/ }).click();
    const brindle = old.locator('.link-item', { hasText: 'Brindle' });
    await expect(brindle).toContainText("$1'500'000.00 appeared on Brindle's account without a log row, at most 30 minutes after Tavrik withdrew exactly that amount.");
    await brindle.scrollIntoViewIfNeeded();
    await old.screenshot({ path: 'test-results/players-legacy-links-dark.png' });
  });
});

test.describe('connected players (AT-41)', () => {
  let app: ElectronApplication;
  let p: Page;
  const open = (name: keyof typeof PLAYERS) => p.evaluate(`location.hash = '#/players/${uuidText(PLAYERS[name].n)}'`);
  const rows = () => p.locator('.link-item');
  const shots = async (name: string) => {
    for (const [theme, other] of [['dark', 'light'], ['light', 'dark']] as const) {
      for (const width of [1440, 900]) {
        await p.setViewportSize({ width, height: 900 });
        const end = `${theme}${width === 900 ? '-900' : ''}.png`;
        await p.getByRole('tablist', { name: 'Player details' }).scrollIntoViewIfNeeded();
        await p.screenshot({ path: `test-results/${name}-${end}` });
        await p.getByRole('region', { name: 'Connected players' }).screenshot({ path: `test-results/${name}-card-${end}` });
      }
      await p.getByRole('button', { name: `Switch to the ${other} theme` }).click();
    }
    await p.setViewportSize({ width: 1440, height: 900 });
  };
  test.beforeAll(async () => {
    // A copy of the master with a note link and two coal sessions that overlap (fixtures, LINKS).
    const save = path.resolve('test-results/fixtures-players-links');
    fs.rmSync(save, { recursive: true, force: true });
    fs.cpSync(fx.master, save, { recursive: true });
    addLinkCases(save);
    const dir = path.resolve('test-results/app-data-players-links');
    fs.rmSync(dir, { recursive: true, force: true });
    app = await electron.launch({ args: ['.', '--open', save], env: { ...process.env, AUDIT_TOOL_DATA: dir } });
    p = await app.firstWindow();
    await p.setViewportSize({ width: 1440, height: 900 });
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Overview');
  });
  test.afterAll(() => app.close());

  test('one row per player: why in plain words, how sure, and the records behind it', async () => {
    await open('Tavrik');
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Tavrik');
    await expect(p.getByRole('tab', { name: /^Connected players/ })).toHaveText('Connected players'); // counted only once opened
    await p.getByRole('tab', { name: /^Connected players/ }).click();
    await expect(p.getByRole('tab', { name: /^Connected players/ })).toHaveText('Connected players (3)');
    await expect(rows().locator('.lname')).toHaveText(['Ombrelune', 'Quenby', 'Brindle']);
    await expect(rows().locator('.strength')).toHaveText(['Proven', 'Proven', 'Likely']);
    await expect(rows().nth(0)).toContainText('Tavrik sent Ombrelune $1M in 1 transfer.');
    await expect(rows().nth(1)).toContainText('Both use account 30, Tavrik and Quenby.');
    await expect(rows().nth(1).getByRole('button')).toHaveCount(0); // a shared account has no log row behind it
    await expect(rows().nth(2)).toContainText("Brindle paid in $2'000'000.00 of banknotes 1 minute after Tavrik withdrew exactly that amount.");
    await expect(p.locator('main')).toContainText('Proven: a shared account or a transfer in the bank\'s log. Likely: banknotes one withdrew and the other paid in within a day, to the exact amount. Weak: both traded the same market at the same time.');
    await rows().nth(2).getByRole('button', { name: 'Show the records' }).click();
    await expect(rows().nth(2).locator('tbody tr')).toHaveCount(2); // the withdrawal and the deposit
    await expect(rows().nth(2).locator('tbody tr td:nth-child(4)')).toHaveText(['Deposit', 'Withdrawal']); // newest first
    await shots('players-links');
    await rows().nth(2).getByRole('button', { name: 'Hide the records' }).click();
  });

  test('a row opens the other player; a weak link names the market and the minutes; no link, one sentence', async () => {
    await rows().nth(2).locator('a.lrow').click();
    await expect(p).toHaveURL(new RegExp(`#/players/${uuidText(PLAYERS.Brindle.n)}$`));
    await expect(p.getByRole('heading', { level: 1 })).toHaveText('Brindle');
    await expect(rows().locator('.lname')).toHaveText(['Tavrik', 'Mikko_82']); // the tab stays open
    await expect(rows().locator('.strength')).toHaveText(['Likely', 'Weak']);
    await expect(rows().nth(1)).toContainText('Both traded coal at the same time, for 3 minutes.');
    await rows().nth(1).getByRole('button', { name: 'Show the records' }).click();
    await expect(rows().nth(1).locator('tbody tr')).toHaveCount(6);
    await shots('players-links-weak');
    await open('AdmiralNoor');
    await expect(p.locator('.empty')).toHaveText('No other player shares an account, a transfer, banknotes or a trading session with AdmiralNoor in this time range.');
    await expect(p.getByRole('tab', { name: /^Connected players/ })).toHaveText('Connected players (0)');
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

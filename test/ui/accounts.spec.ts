// The Bank accounts screen with the invented network and with the old 2.1.2 save, in both themes.
// Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-accounts'));

async function launch(data: string, open: string[]) {
  fs.rmSync(data, { recursive: true, force: true });
  const program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  const page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
  return { program, page };
}

test.describe('the invented network', () => {
  let program: ElectronApplication;
  let page: Page;
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-accounts'), [fx.master, ...fx.slaves])));
  test.afterAll(() => program.close());

  test('the list: largest gap first, then most money; deleted and company accounts marked', async () => {
    await page.getByRole('link', { name: 'Bank accounts', exact: true }).click();
    // 12 to 18 are gone from the bank's files and still have snapshots or log rows; 14 and 12 have gaps above $1'000.
    await expect(page.locator('aside .badge')).toHaveText(['14', '12', '41', '24', '11', '3', '27', '10', '7', '30', '13', '15', '16', '17', '18', '31', '32', '33']);
    await expect(page.locator('aside .pick').first()).toContainText(/Deleted account\s*\$10'000\.00 unexplained/);
    const sub = page.locator('aside .pick').first().locator('.small');
    expect(await sub.evaluate((e) => e.getBoundingClientRect().height)).toBeLessThan(30); // one line, even beside the dot
    await expect(page.locator('aside .pick .dot')).toHaveCount(2);
    await expect(page.locator('aside a[href="#/accounts/41"]')).toContainText(/Northreach Rail Co.\s*\$90'071.99B · company/);
    await expect(page.locator('aside a[href="#/accounts/31"]')).toContainText(/Old savings\s*\$0\.00 · frozen/);
    await page.locator('aside a[href="#/accounts/41"]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 41 · Northreach Rail Co.');
    await expect(page.locator('.facts')).toContainText('Company account');
    await expect(page.locator('.facts')).toContainText('User: AdmiralNoor, every right');
    await expect(page.locator('.fvalue')).toHaveText(["$90'071.99B", '1', '1']);
    await expect(page.locator('.fvalue').first()).toHaveAttribute('title', "$90'071'992'547'409.93");
  });

  test('the check: a deleted account whose balance fell without a log entry', async () => {
    await page.locator('aside a[href="#/accounts/14"]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 14 · deleted');
    await expect(page.locator('.facts')).toContainText('Deleted account');
    await expect(page.locator('.facts')).toContainText("Gone from the bank's files");
    await expect(page.locator('.facts')).not.toContainText('frozen');
    const check = page.getByRole('region', { name: 'Does the log explain the balance?' });
    await expect(check.locator('.tvalue')).toHaveText(["$50'000.00", '$0.00', '$0.00', '$0.00', "$50'000.00", "$40'000.00"]);
    await expect(check.locator('.vvalue')).toHaveText("-$10'000.00");
    await expect(check).toContainText("The log does not explain $10'000.00. It left this account between two snapshots,");
    await expect(check).toContainText('In that time the log has entries without a direction, which may explain it.');
    await expect(check).toContainText('How much this says: some. In the mod version this server ran');
    await expect(page.locator('.chart path.band')).toHaveCount(1);
    await expect(page.locator('.legend')).toContainText('Orange band: the balance changed and the log has no entry for it. Scroll to zoom');

    await check.getByRole('button', { name: 'Show it in the history' }).click();
    await expect(page.getByRole('group', { name: 'Filter the history' }).getByRole('button', { name: 'No log entry' })).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainClass('gap');
    await expect(rows.first().locator('td')).toHaveText([/Nov 2026, \d\d:\d\d:00 to \d\d:\d\d:00$/,
      /^Balance fell with no log entry\s*Seen between two balance snapshots; the log has entries without a direction in that time: set by an admin$/, "-$10'000.00", "$40'000.00", 'not recorded', '']);
    await page.getByRole('button', { name: 'Everything', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('main')).toContainText('2 entries, newest first.');
    // A row without a direction still shows its amount as money.
    await expect(rows.nth(1).locator('td').nth(2)).toHaveText("$10'000.00");
    await page.setViewportSize({ width: 1440, height: 1500 });
    const wrap = page.locator('table').locator('..');
    expect(await wrap.evaluate((e) => e.scrollWidth - e.clientWidth)).toBe(0); // the table fits the card
    await page.screenshot({ path: 'test-results/accounts-check-dark.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.locator('aside a[href="#/accounts/12"]').click();
    await expect(check.locator('.vvalue')).toHaveText("+$5'000.00");
    await expect(check).toContainText("The log does not explain $5'000.00. It came into this account between two snapshots,");
    await page.locator('aside a[href="#/accounts/13"]').click();
    // Two gaps of exactly $1'000, the default threshold: not above it.
    await expect(check).toContainText('The log explains every change of money on this account in this time range.');
    await expect(page.getByRole('button', { name: 'Show it in the history' })).toHaveCount(0);
    await page.getByRole('button', { name: 'No log entry' }).click();
    await expect(page.locator('main')).toContainText('The log explains every change of this account in the selected time range.');
  });

  test('one account: chart per item, history with filters', async () => {
    await page.locator('aside a[href="#/accounts/11"]').click();
    await expect(page).toHaveURL(/#\/accounts\/11$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 11 · Tavrik');
    await expect(page.locator('.facts')).toContainText('Personal account');
    await expect(page.locator('.facts')).toContainText('Owner: Tavrik');
    await expect(page.locator('.fvalue')).toHaveText(["$940'830.00", '64', '2']);
    await expect(page.locator('.verdict')).toContainText('The log explains every change of money on this account in this time range.');
    // AT-56: every item in one chart, each switched on and off in the list beside it.
    const lines = page.getByRole('group', { name: 'Items on the chart' }).getByRole('button');
    await expect(lines).toHaveText(['Money', 'Diamond']);
    await expect(page.getByRole('img', { name: /^Balances on account 11 from / })).toBeVisible();
    await expect(page.locator('.chart path.line')).toHaveCount(2);
    await expect(page.locator('.readout')).toContainText("Money $940'830.00");
    await expect(page.locator('.readout')).toContainText('Diamond 0'); // at the end of the range: the diamonds are sold
    await lines.filter({ hasText: 'Diamond' }).click();
    await expect(lines.filter({ hasText: 'Diamond' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.chart path.line')).toHaveCount(1);
    await page.getByRole('searchbox', { name: 'Find an item on the chart' }).fill('dia');
    await expect(lines).toHaveText(['Diamond']);
    await page.getByRole('button', { name: 'Show all items' }).click();
    await page.getByRole('searchbox', { name: 'Find an item on the chart' }).fill('');
    await expect(page.locator('.chart path.line')).toHaveCount(2);
    // Zoom in with the wheel over the chart, Ctrl+Space shows everything again.
    const plot = page.getByRole('img', { name: /^Balances on account 11 from / });
    const before = await plot.getAttribute('aria-label');
    await plot.hover();
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
    await expect(plot).not.toHaveAttribute('aria-label', before!);
    await page.keyboard.press('Control+Space');
    await expect(plot).toHaveAttribute('aria-label', before!);

    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(10);
    await expect(page.locator('main')).toContainText('The latest 10 of 64 entries, newest first. Trade entries carry no balance');
    await expect(rows.first().locator('td')).toHaveText([/^\d+ Nov 2026, \d\d:\d\d:\d\d$/, /^Transfer\s*to account 24$/, "-$1'000'000.00", "$940'830.00", 'Tavrik', '']);
    await expect(rows.nth(3).locator('td').nth(1)).toHaveText(/^Sold 100 Diamond\s*$/); // BS-256: no origin in a log with the column is the master, which is not named
    await expect(rows.nth(3).locator('td').nth(3)).toHaveText('not recorded');
    await expect(rows.nth(3).locator('td').nth(4)).toHaveText('StockMarket, for Tavrik');
    await expect(rows.nth(3).locator('td').nth(5)).toHaveText(/^sm:order:\d+$/);
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.screenshot({ path: 'test-results/accounts-dark.png' });

    await page.getByRole('button', { name: 'Paid in and out' }).click();
    await expect(rows.locator('td:nth-child(2) > span:first-child')).toHaveText(['Transfer', 'Withdrawal', 'Withdrawal', 'Starting balance']);
    await expect(rows.last().locator('td').nth(4)).toHaveText('The bank, for Tavrik');
    // BS-256 and BS-258: a slave's row names its server, and where the player stood for the first withdrawal.
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText(/^Withdrawal\s*on mining-1$/);
    await expect(rows.nth(2).locator('td').nth(1)).toHaveText(/^Withdrawal\s*at the overworld, -230 70 -920$/);
    await page.screenshot({ path: 'test-results/accounts-where-dark.png' });
    await expect(page.locator('main')).toContainText('4 entries of 64, newest first.');
    await page.getByRole('button', { name: 'Admin actions' }).click();
    await expect(page.locator('main')).toContainText('No entries of this kind in the selected time range.');
    await page.getByRole('button', { name: 'Trades' }).click();
    await expect(rows).toHaveCount(10);
    await page.getByRole('button', { name: 'Show all', exact: true }).click();
    await expect(rows).toHaveCount(60);

    await page.getByRole('combobox', { name: 'Item to check' }).selectOption('Diamond');
    await expect(page.getByRole('region', { name: 'Does the log explain the balance?' })).toContainText('Diamond');
    await expect(page.locator('.verdict')).toContainText('The log explains every change of Diamond on this account in this time range.');
  });

  test('admin actions and transfers link to the other account', async () => {
    await page.locator('aside a[href="#/accounts/7"]').click();
    await page.getByRole('button', { name: 'Admin actions' }).click();
    const row = page.locator('tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row.locator('td')).toHaveText([/Nov 2026/, /^Removed by an admin\s*exploit profit removed$/, "-$200'000.00", "$52'270.00", 'AdmiralNoor, as admin', '']);
    await page.locator('aside a[href="#/accounts/24"]').click();
    await page.getByRole('link', { name: 'account 11' }).click();
    await expect(page).toHaveURL(/#\/accounts\/11$/);
    // The filter goes back to everything for another account.
    await expect(page.getByRole('group', { name: 'Filter the history' }).getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the shared account lists its users; an account without slots says so', async () => {
    await page.locator('aside a[href="#/accounts/30"]').click();
    await expect(page.locator('.facts')).toContainText('Shared account');
    await expect(page.locator('.facts')).toContainText('User: Tavrik, every right');
    await expect(page.locator('.facts')).toContainText('User: Quenby, deposit, withdraw');
    await expect(page.getByRole('link', { name: 'Open the owner' })).toHaveCount(0);
    await page.locator('aside a[href="#/accounts/31"]').click();
    await expect(page.locator('.facts')).toContainText('Frozen');
    await expect(page.locator('main')).toContainText('This account has no item slots in the bank files.');
    await page.evaluate("location.hash = '#/accounts/99'");
    await expect(page.locator('main')).toContainText('Account 99 is not in the loaded saves.');
  });

  test('account numbers on the Players screen open the account', async () => {
    await page.getByRole('link', { name: 'Players', exact: true }).click();
    await page.locator('.facts').getByRole('link', { name: '30' }).click();
    await expect(page).toHaveURL(/#\/accounts\/30$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 30 · Tavrik and Quenby');
    await page.goBack();
    await page.getByRole('tab', { name: 'Bank history' }).click();
    await page.locator('.entry').first().getByRole('link', { name: 'account 24' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 24 · Ombrelune');
  });

  test('the light theme', async () => {
    await page.locator('aside a[href="#/accounts/11"]').click();
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await page.screenshot({ path: 'test-results/accounts-light.png' });
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  });
});

test.describe('an old 2.1.2 save', () => {
  let program: ElectronApplication;
  let page: Page;
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-accounts-legacy'), [fx.legacy])));
  test.afterAll(() => program.close());

  test('the check says once that this version did not log trades and admin actions; its gaps are rated low', async () => {
    await page.getByRole('link', { name: 'Bank accounts', exact: true }).click();
    await expect(page.locator('aside .badge')).toHaveText(['27', '3', '11', '7', '10', '41', '24', '30', '31', '32', '33']);
    await expect(page.locator('main')).toContainText('BankSystem 2.1.2 wrote this save. It did not log trades or admin actions: orders stand in for trades, and gaps are expected and rated low.');
    await expect(page.getByText('did not log trades or admin actions')).toHaveCount(1);
    await expect(page.locator('.verdict')).toContainText("The log does not explain $10'000'000.00."); // an admin raise, unlogged in 2.1.2
    await expect(page.locator('.verdict')).toContainText('How much this says: little.');
    await page.screenshot({ path: 'test-results/accounts-legacy-check-dark.png' });
    await page.locator('aside a[href="#/accounts/11"]').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 11 · Tavrik');
    await expect(page.getByText('did not log trades or admin actions')).toHaveCount(1);
    await expect(page.locator('tbody tr td:nth-child(2) > span:first-child')).toHaveText(['Balance rose with no log entry', 'Withdrawal', 'Withdrawal']); // the notes 2.1.2 put back unlogged; no row for the starting balance
    await expect(page.locator('tbody tr').nth(1).locator('td').nth(3)).toHaveText('not recorded');
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: 'test-results/accounts-legacy-dark.png' });
  });
});

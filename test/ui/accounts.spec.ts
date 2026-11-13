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

  test('the list: most money first, the company account marked, the first one opens', async () => {
    await page.getByRole('link', { name: 'Bank accounts', exact: true }).click();
    await expect(page.locator('aside .badge')).toHaveText(['41', '24', '11', '3', '27', '10', '7', '30', '31', '32', '33']);
    await expect(page.locator('aside .pick').first()).toContainText(/Northreach Rail Co.\s*\$90'071.99B · company/);
    await expect(page.locator('aside .pick').nth(8)).toContainText(/Old savings\s*\$0\.00 · frozen/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 41 · Northreach Rail Co.');
    await expect(page.locator('.facts')).toContainText('Company account');
    await expect(page.locator('.facts')).toContainText('User: AdmiralNoor, every right');
    await expect(page.locator('.fvalue')).toHaveText(["$90'071.99B", '1', '1']);
    await expect(page.locator('.fvalue').first()).toHaveAttribute('title', "$90'071'992'547'409.93");
  });

  test('one account: chart per item, history with filters', async () => {
    await page.locator('aside a[href="#/accounts/11"]').click();
    await expect(page).toHaveURL(/#\/accounts\/11$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 11 · Tavrik');
    await expect(page.locator('.facts')).toContainText('Personal account');
    await expect(page.locator('.facts')).toContainText('Owner: Tavrik');
    await expect(page.locator('.fvalue')).toHaveText(["$940'830.00", '64', '2']);
    await expect(page.getByRole('group', { name: 'What to chart' }).getByRole('button')).toHaveText(['Money', 'Diamond']);
    await expect(page.getByRole('img', { name: /^Money on account 11 from / })).toBeVisible();

    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(10);
    await expect(page.locator('main')).toContainText('The latest 10 of 64 entries, newest first. Trade entries carry no balance');
    await expect(rows.first().locator('td')).toHaveText([/^\d+ Nov 2026, \d\d:\d\d:\d\d$/, /^Transfer\s*to account 24$/, "-$1'000'000.00", "$940'830.00", 'Tavrik', '']);
    await expect(rows.nth(3).locator('td').nth(1)).toHaveText('Sold 100 Diamond');
    await expect(rows.nth(3).locator('td').nth(3)).toHaveText('not recorded');
    await expect(rows.nth(3).locator('td').nth(4)).toHaveText('StockMarket, for Tavrik');
    await expect(rows.nth(3).locator('td').nth(5)).toHaveText(/^sm:order:\d+$/);
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.screenshot({ path: 'test-results/accounts-dark.png' });

    await page.getByRole('button', { name: 'Paid in and out' }).click();
    await expect(rows.locator('td:nth-child(2) > span:first-child')).toHaveText(['Transfer', 'Withdrawal', 'Withdrawal', 'Starting balance']);
    await expect(rows.last().locator('td').nth(4)).toHaveText('The bank, for Tavrik');
    await expect(page.locator('main')).toContainText('4 entries of 64, newest first.');
    await page.getByRole('button', { name: 'Admin actions' }).click();
    await expect(page.locator('main')).toContainText('No entries of this kind in the selected time range.');
    await page.getByRole('button', { name: 'Trades' }).click();
    await expect(rows).toHaveCount(10);
    await page.getByRole('button', { name: 'Show all' }).click();
    await expect(rows).toHaveCount(60);

    await page.getByRole('button', { name: 'Diamond' }).click();
    await expect(page.getByRole('img', { name: /^Diamond on account 11 from / })).toBeVisible();
    await expect(page.locator('.chart')).toContainText('3\'000');
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

  test('the screen says once that the history is incomplete', async () => {
    await page.getByRole('link', { name: 'Bank accounts', exact: true }).click();
    await page.locator('aside a[href="#/accounts/11"]').click();
    await expect(page.getByText('did not log trades or admin actions')).toHaveCount(1);
    await expect(page.locator('tbody tr td:nth-child(2) > span:first-child')).toHaveText(['Withdrawal', 'Withdrawal', 'Deposit']);
    await expect(page.locator('tbody tr').first().locator('td').nth(3)).toHaveText('not recorded');
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: 'test-results/accounts-legacy-dark.png' });
  });
});

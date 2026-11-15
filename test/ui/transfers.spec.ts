// The Transfers tab of Saves and servers: the transfer classes as tiles on the invented network, a tile filtering
// the table, and the sentence a save without a journal gets. Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, T0 } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-transfers'));
const MIN = 60_000;
/** The value of a datetime-local field, in the computer's time zone like the program's. */
const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(0, 16);
let program: ElectronApplication;
let page: Page;

async function launch(name: string, open: string[]) {
  const data = path.resolve(`test-results/app-data-transfers-${name}`);
  fs.rmSync(data, { recursive: true, force: true });
  program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
  await page.evaluate("location.hash = '#/saves/transfers'");
}
const tile = (label: string) => page.getByRole('group', { name: 'Filter transfers by result' }).getByRole('button', { name: new RegExp(`^${label}`) });

test.describe('the invented network', () => {
  test.beforeAll(() => launch('network', [fx.master, ...fx.slaves]));
  test.afterAll(() => program.close());

  test('the answer, one tile per class with its count, newest first', async () => {
    await expect(page.getByRole('tab', { name: 'Transfers between servers' })).toHaveAttribute('aria-selected', 'true');
    // The transfer cases of the fixtures (TRANSFER_CASES) and the three plain deposits.
    await expect(page.locator('.lead')).toHaveText('5 of 17 transfers need a look: 1 lost on the way, 2 arrived twice, 1 came from nothing, 1 left for an admin.');
    await expect(page.locator('.tile .tlabel')).toHaveText(['Lost on the way', 'Arrived twice', 'Came from nothing', 'Left for an admin', 'Matched',
      'Known gap in the mods', 'Cannot tell', 'Newer than a copy']);
    await expect(page.locator('.tile .tcount')).toHaveText(['1', '2', '1', '1', '7', '1', '2', '2']);
    await expect(page.locator('tbody tr')).toHaveCount(10); // one page
    await expect(page.locator('.foot')).toContainText('The latest 10 of 17 transfers, newest first.');
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(17);
    // The full id on hover, a short one on the screen.
    await expect(page.locator('tbody tr').first().locator('.mono')).toHaveAttribute('title', /^c0000000-0000-4000-8000-0000000000[0-9a-f]{2}$/);
    await page.screenshot({ path: 'test-results/transfers-dark.png' });
  });

  test('a tile filters the table; a row says what each side did and links the player, the account and the finding', async () => {
    await tile('Arrived twice').click();
    await expect(tile('Arrived twice')).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.chip')).toHaveText(['Arrived twice', 'Arrived twice']);
    // Iron paid in on the slave and diamonds credited on the master: newest first, so it comes before Ombrelune's deposit.
    const swap = rows.first();
    await expect(swap).toContainText('mining-1 to survival-main');
    await expect(swap).toContainText("mining-1 took 500 Iron ingot, survival-main credited 500 Diamond.");
    await expect(swap.getByRole('link', { name: 'AdmiralNoor' })).toHaveAttribute('href', /^#\/players\//);
    await expect(swap.getByRole('link', { name: 'account 10' })).toHaveAttribute('href', '#/accounts/10');
    await expect(rows.nth(1)).toContainText("mining-1 took 700.00 $, survival-main credited 1'400.00 $.");
    await expect(page.locator('.foot')).toContainText('2 transfers of 17, newest first. Pick the tile again to show them all.');
    await page.screenshot({ path: 'test-results/transfers-twice-dark.png' });
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await page.screenshot({ path: 'test-results/transfers-twice-light.png' });
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();

    await swap.getByRole('link', { name: 'Open the finding' }).click();
    await expect(page).toHaveURL(/#\/findings\/transfer%3Ac0000000-0000-4000-8000-000000000011$/);
    await page.goBack();
    await tile('Matched').click();
    await expect(page.locator('tbody tr')).toHaveCount(7);
    await expect(page.locator('tbody').getByRole('link', { name: 'Open the finding' })).toHaveCount(0);
    await tile('Matched').click(); // again: every result
    await expect(page.locator('tbody tr')).toHaveCount(10);
  });

  test('the time range and the server filter apply', async () => {
    await page.getByRole('button', { name: 'Server: all servers' }).click();
    await page.locator('#server-menu').getByRole('button', { name: /^nether-hub/ }).click();
    // nether-hub's own deposit, and the one only the master has (a server filter keeps those).
    await expect(page.locator('.tile .tcount')).toHaveText(['0', '0', '0', '0', '1', '0', '0', '1']);
    await page.getByRole('button', { name: 'Server: nether-hub' }).click();
    await page.locator('#server-menu').getByRole('button', { name: 'All servers' }).click();
    await expect(page.locator('.tile .tcount').nth(4)).toHaveText('7');

    // Hours before the first transfer: the tiles stay, the table says so.
    await page.getByRole('button', { name: 'Time range: Everything' }).click();
    await page.locator('#range-menu').getByLabel('From').fill(local(T0 - 300 * MIN));
    await page.locator('#range-menu').getByLabel('To').fill(local(T0 - 200 * MIN));
    await page.locator('#range-menu').getByRole('button', { name: 'Use this range' }).click();
    await expect(page.locator('main')).toContainText('No transfers between servers in this time range.');
    await expect(page.locator('.lead')).toHaveCount(0);
    await page.getByRole('button', { name: /^Time range:/ }).click();
    await page.locator('#range-menu').getByRole('button', { name: 'Everything', exact: true }).click();
    await expect(page.locator('.tile .tcount').nth(4)).toHaveText('7');
  });
});

test.describe('an old 2.1.2 save', () => {
  test.beforeAll(() => launch('legacy', [fx.legacy]));
  test.afterAll(() => program.close());

  test('no journal: one sentence says why, and no tiles', async () => {
    await expect(page.locator('main')).toContainText("No slave save is loaded. Every transfer is written down in a slave's journal, so add the slaves to check them.");
    await expect(page.locator('.tile')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/transfers-empty-dark.png' });
  });
});

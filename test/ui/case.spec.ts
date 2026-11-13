// Case and report (DESIGN_SPEC 6.8, 8.10) on the old 2.1.2 save with Tavrik's extra money (FLOW): where the money stands,
// the pinned evidence, the cutoff, the admin question, the table and the commands; the choices survive a restart.
// Screenshots land in test-results/.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, PLAYERS, T0, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-case'), true);
const data = path.resolve('test-results/app-data-case');
const PUMP = `hour-profit:${uuidText(PLAYERS.Tavrik.n)}@${T0}`;
const QUENBY = `order-rate:${uuidText(PLAYERS.Quenby.n)}@${T0 + 46 * 60_000}`;
let program: ElectronApplication;
let page: Page;

async function launch(open: string[]) {
  program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
}
const go = (hash: string) => page.evaluate(`location.hash = '${hash}'`);
const section = (name: string) => page.getByRole('region', { name });
const cut = (name: RegExp) => page.getByRole('group', { name: 'Moment to keep' }).getByRole('button', { name });
const shot = async (name: string) => {
  for (const [theme, other] of [['dark', 'light'], ['light', 'dark']] as const) {
    for (const [width, end] of [[1440, ''], [900, '-900']] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/${name}-${theme}${end}.png` });
      await page.setViewportSize({ width, height: 2400 }); // the screen scrolls inside main: a section must fit to be captured whole
      await section('Where the money stands').screenshot({ path: `test-results/${name}-bar-${theme}${end}.png` });
      await section('Evidence').screenshot({ path: `test-results/${name}-evidence-${theme}${end}.png` });
      await section('What to take back').screenshot({ path: `test-results/${name}-take-${theme}${end}.png` });
    }
    await page.getByRole('button', { name: `Switch to the ${other} theme` }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

test.beforeAll(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  await launch([fx.legacy]);
});
test.afterAll(() => program.close());

test('the strongest incident: where the money stands, the evidence, the table and the commands', async () => {
  // Two pins, one with a note.
  for (const id of [PUMP, QUENBY]) {
    await go(`#/findings/${encodeURIComponent(id)}`);
    await page.getByRole('region', { name: 'Selected finding' }).getByRole('button', { name: 'Pin to the case' }).click();
  }
  await page.getByRole('region', { name: 'Selected finding' }).getByRole('button', { name: 'Add a note' }).click();
  await page.getByRole('region', { name: 'Selected finding' }).getByLabel('Note').fill('Bought fast, then the admin stepped in.');
  await page.getByRole('region', { name: 'Selected finding' }).getByRole('button', { name: 'Save the note' }).click();
  await page.getByRole('link', { name: 'Case: 2 pinned' }).click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Case: .*Tavrik.* on the diamond market$/);
  await expect(section('Where the money stands').locator('h2')).toHaveText(/^Where the \$[\d.]+M stands$/);
  await expect(section('Where the money stands').locator('.lg')).toContainText(['Taken back by this plan', 'Spent on items, removed as items']);
  await expect(section('Where the money stands').getByRole('link', { name: 'Open the money flow' })).toHaveAttribute('href', `#/flow/${encodeURIComponent(PUMP)}`);

  const pins = section('Evidence').locator('.pin');
  await expect(pins).toHaveCount(2);
  await expect(pins.nth(1)).toContainText('Bought fast, then the admin stepped in.');
  await expect(pins.nth(0)).toContainText('No note yet');
  await expect(pins.first().getByRole('button', { name: 'Move up' })).toBeDisabled();

  await expect(cut(/^The end of/)).toHaveAttribute('aria-pressed', 'true');
  await expect(cut(/^The end of/)).toContainText('Recommended');
  const rows = section('What to take back').locator('table').first().locator(':scope > tbody > tr');
  await expect(rows.locator('td:first-child a.name')).toHaveText(['Tavrik', 'Ombrelune', 'Brindle']); // the incident's own players first
  await expect(rows.filter({ hasText: 'Brindle' })).toContainText("likely paid in $1'500'000.00 of Tavrik's notes");
  await expect(rows.last()).toContainText('Total');
  await rows.filter({ hasText: 'Tavrik' }).getByRole('button', { name: /^and [\d']+ items$/ }).click();
  await expect(section('What to take back').locator('tr.items')).toContainText('Coal');

  // The save was written by 2.1.2: its commands first; 2.2.0 freezes the accounts around them.
  const group = page.getByRole('group', { name: 'BankSystem version on the server' });
  await expect(group.getByRole('button', { name: 'BankSystem 2.1.2' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('pre.code').first()).toContainText(`/money remove Tavrik `);
  await expect(page.locator('pre.code.list')).toContainText(`Account ${PLAYERS.Tavrik.account} (Tavrik): Coal, remove`);
  await expect(section('What to take back')).toContainText('BankSystem has no command that removes items');
  await shot('case');
  await group.getByRole('button', { name: 'BankSystem 2.2.0' }).click();
  await expect(page.locator('pre.code').first()).toContainText(`/banksystem freeze ${PLAYERS.Tavrik.account} on`);
  await page.setViewportSize({ width: 1440, height: 2400 });
  await section('What to take back').screenshot({ path: 'test-results/case-take-220-dark.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(section('What to take back')).not.toContainText(/\d,\d{3}/); // the apostrophe format everywhere
});

test('the 2.1.2 removal asks the admins; the answer, the cutoff and the order survive a restart', async () => {
  await section('Evidence').locator('.pin').first().getByRole('button', { name: 'Move down' }).click();
  await expect(section('Evidence').locator('.pin').first()).toContainText('Bought fast');
  await page.getByRole('combobox').selectOption(QUENBY);
  await expect(page).toHaveURL(new RegExp(`#/case/${encodeURIComponent(QUENBY)}$`));
  await expect(page.locator('h3.step', { hasText: 'Did an admin remove' })).toHaveText(/Did an admin remove \$200'000\.00 from Quenby on/);
  const answers = page.getByRole('group', { name: /^Answer for account 7 on/ });
  await expect(answers.getByRole('button', { name: 'Not sure' })).toHaveAttribute('aria-pressed', 'true');
  await expect(section('Where the money stands')).toContainText('Left the account, not confirmed');
  await expect(section('Where the money stands').locator('.open')).toContainText('Ask the admins whether they removed');
  const take = await section('What to take back').locator('table').first().textContent();
  await answers.getByRole('button', { name: 'Yes' }).click();
  await expect(section('Where the money stands')).toContainText('Removed by an admin already');
  await expect(section('Where the money stands').locator('.open')).toHaveCount(0);
  expect(await section('What to take back').locator('table').first().textContent()).toBe(take); // the answer changes no amount
  await expect(section('What to take back')).toContainText('Nothing to take back from the bank: it holds less than at the cutoff.');
  await shot('case-legacy');

  await cut(/^A time you pick/).click();
  await expect(cut(/^A time you pick/)).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel("The time, in this computer's time zone").fill('2026-11-04T11:30:00');
  await page.getByLabel("The time, in this computer's time zone").dispatchEvent('change');
  await expect(cut(/^A time you pick/)).toContainText('4 Nov 2026, 11:30:00');

  await program.close();
  await launch([]);
  await go(`#/case/${encodeURIComponent(QUENBY)}`);
  await expect(page.getByRole('group', { name: /^Answer for account 7 on/ }).getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cut(/^A time you pick/)).toHaveAttribute('aria-pressed', 'true');
  await expect(cut(/^A time you pick/)).toContainText('4 Nov 2026, 11:30:00');
  await expect(section('Evidence').locator('.pin').first()).toContainText('Bought fast');
});

// CSV export (DESIGN_SPEC 9) on the invented network: the whole table behind three screens, written through the save dialog
// of main (stubbed as in case.spec), never into a save; and the search finding a transfer by its id.
// Screenshots of a table heading with its button land in test-results/.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { SEP } from '../../src/shared/csv.ts';
import { buildFixtures, TRANSFER_CASES } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-csv'));
const data = path.resolve('test-results/app-data-csv');
const out = path.resolve('test-results/csv');
let program: ElectronApplication;
let page: Page;

/** RFC 4180 records of a file the tool wrote: the BOM checked and cut, fields unquoted. */
function read(file: string): string[][] {
  const text = fs.readFileSync(file, 'utf8');
  expect(text.startsWith('\uFEFF')).toBe(true);
  expect(text.endsWith('\r\n')).toBe(true);
  const rows: string[][] = [[]];
  let field = '', quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === SEP) rows.at(-1)!.push(field), (field = '');
    else if (c === '\r' && text[i + 1] === '\n') rows.at(-1)!.push(field), (field = ''), rows.push([]), i++;
    else field += c;
  }
  rows.pop(); // after the last CRLF
  return rows;
}
const answer = (file: string) => program.evaluate(({ dialog }, f) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as never; }, file);
const go = (hash: string) => page.evaluate(`location.hash = '${hash}'`);

test.beforeAll(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  program = await electron.launch({ args: ['.', ...[fx.master, ...fx.slaves].flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
});
test.afterAll(() => program.close());

test('the player list: every player, the ids the screen hides, amounts in full', async () => {
  await go('#/players');
  await expect(page.locator('aside .pick')).toHaveCount(6);
  await answer(path.join(out, 'players.csv'));
  await page.getByRole('button', { name: 'Export the player list as CSV' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as players.csv');
  const [head, ...rows] = read(path.join(out, 'players.csv'));
  expect(head!.slice(0, 2)).toEqual(['Player', 'Player uuid']);
  expect(rows.map((r) => r[0])).toEqual(['Tavrik', 'Quenby', 'Ombrelune', 'AdmiralNoor', 'Brindle', 'Mikko_82']);
  expect(rows[0]![1]).toBe('a1b2c3d4-e5f6-4a7b-8c9d-000000000001');
  expect(rows.flat().some((c) => c.includes('$'))).toBe(false);
  expect(head!.some((h) => h.endsWith('($)'))).toBe(true);
});

test('an account history: the filter applies, all rows, not only the first page', async () => {
  await go('#/accounts/11');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account 11 · Tavrik');
  await expect(page.locator('main')).toContainText('The latest 10 of 64 entries');
  const history = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'History' }) });
  for (const theme of ['dark', 'light'] as const) {
    await history.locator('.cardhead').first().screenshot({ path: `test-results/csv-button-${theme}.png` });
    await page.getByRole('button', { name: `Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme` }).click();
  }
  await answer(path.join(out, 'history.csv'));
  await page.getByRole('button', { name: 'Export the history as CSV' }).click();
  await expect(history.getByRole('status')).toHaveText('Saved as history.csv');
  let [head, ...rows] = read(path.join(out, 'history.csv'));
  expect(head![0]).toMatch(/^Time \(.+\)$/);
  expect(rows).toHaveLength(64);
  expect(rows[0]![0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  expect(rows[0]![head!.indexOf('Money ($)')]).toBe("-1'000'000.00"); // a number cell keeps its minus: no injection quote

  await page.getByRole('button', { name: 'Paid in and out' }).click();
  await page.getByRole('button', { name: 'Export the history as CSV' }).click();
  [head, ...rows] = read(path.join(out, 'history.csv'));
  expect(rows.map((r) => r[head!.indexOf('What')])).toEqual(['Transfer', 'Withdrawal', 'Withdrawal', 'Starting balance']);
});

test('the transfers: all 17 of the time range, with their ids; a save folder is refused', async () => {
  await go('#/saves/transfers');
  await expect(page.locator('tbody tr')).toHaveCount(10); // one page
  const button = page.getByRole('button', { name: 'Export the transfers as CSV' });
  await answer(path.join(out, 'transfers.csv'));
  await button.click();
  await expect(page.getByRole('status')).toHaveText('Saved as transfers.csv');
  const [head, ...rows] = read(path.join(out, 'transfers.csv'));
  expect(rows).toHaveLength(17);
  const ids = rows.map((r) => r[head!.indexOf('Transfer id')]);
  expect(TRANSFER_CASES.map((c) => c.id).filter((id) => /^[0-9a-f-]{36}$/.test(id)).filter((id) => !ids.includes(id))).toEqual([]);

  const inside = path.join(fx.master, 'transfers.csv');
  await answer(inside);
  await button.click();
  await expect(page.getByRole('status')).toHaveText(/^The table was not saved: that folder belongs to a loaded save/);
  await expect(page.getByRole('status')).toHaveClass(/bad/);
  expect(fs.existsSync(inside)).toBe(false);
});

test('the search finds a transfer by its id and marks it on the Transfers tab', async () => {
  const lost = TRANSFER_CASES.find((c) => c.class === 'lost')!.id;
  await go('#/overview');
  const field = page.getByRole('searchbox', { name: 'Search everything' });
  await field.fill(lost.toUpperCase());
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.locator('.group')).toHaveText(['Transfers']);
  await expect(results.locator('a.hit')).toHaveCount(1);
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/saves/transfers/${lost}$`));
  const row = page.locator(`[id="transfer-${lost}"]`);
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(row).toBeInViewport();
  await expect(page.locator('tr[aria-current]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/csv-search-transfer-dark.png' });

  await field.fill('c0000000-0000-4000-8000-ffffffffffff');
  await expect(page.getByRole('region', { name: 'Search results' })).toContainText('Nothing found.');
});

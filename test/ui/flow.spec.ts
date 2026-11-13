// Money flow (DESIGN_SPEC 6.6, 8.10) on the invented network with Tavrik's extra money (FLOW): the answer first, the three
// columns, the player switch, a picked part with its records, and the 2.1.2 save's estimates. Screenshots land in test-results/.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, PLAYERS, T0, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-flow'), true);
const PUMP = `hour-profit:${uuidText(PLAYERS.Tavrik.n)}@${T0}`;
let program: ElectronApplication;
let page: Page;

async function launch(name: string, open: string[]) {
  const data = path.resolve(`test-results/app-data-flow-${name}`);
  fs.rmSync(data, { recursive: true, force: true });
  program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
  await page.evaluate(`location.hash = '#/flow/${encodeURIComponent(PUMP)}'`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Money flow');
}
const node = (name: string) => page.locator('.node', { has: page.locator('.nname', { hasText: new RegExp(`^${name}$`) }) });
const shot = async (name: string) => {
  for (const [theme, other] of [['dark', 'light'], ['light', 'dark']] as const) {
    for (const [width, end] of [[1440, ''], [900, '-900']] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/${name}-${theme}${end}.png` });
      await page.locator('section.card').first().screenshot({ path: `test-results/${name}-chart-${theme}${end}.png` });
      await page.locator('.detail').screenshot({ path: `test-results/${name}-detail-${theme}${end}.png` });
    }
    await page.getByRole('button', { name: `Switch to the ${other} theme` }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

test.describe('the invented network', () => {
  test.beforeAll(() => launch('network', [fx.master, ...fx.slaves]));
  test.afterAll(() => program.close());

  test('the answer first, then where the money came from, who got it and where it is now', async () => {
    await expect(page.locator('.lead')).toHaveText("Of the $15.33M these players had or got since the incident's start ($5.46M of it made on the diamond market), $10.32M is still in the bank, $4M was taken out as banknotes and $1M was sent to other accounts.");

    // The start first on the left, the bank first on the right, the rest largest first.

    await expect(page.locator('.node .nname').first()).toHaveText('At the start');

    await expect(page.locator('.node .nname').filter({ hasText: /^(Still in the bank|Taken out as notes|Spent on items)$/ }).first()).toHaveText('Still in the bank');
    await expect(page.locator('.heads span')).toHaveText(['Came from', 'Went to', 'Is now']);
    for (const n of ['At the start', 'Diamond market', 'Added by an admin', 'Other accounts', 'Tavrik', 'Ombrelune', 'Still in the bank', 'Taken out as notes', 'Spent on items', 'Lost trading', 'Sent to other accounts', 'Not explained']) {
      await expect(node(n), n).toHaveCount(1);
    }
    // Nothing on the current save is an estimate.
    await expect(page.locator('.namount', { hasText: 'about' })).toHaveCount(0);
    // Taken out as notes is picked first: what it is made of, and where the notes are now.
    await expect(node('Taken out as notes')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.dtitle')).toHaveText('Taken out as notes');
    // Two groups, each adding up to the node: who took them out, and where they are now.
    await expect(page.locator('.dright h3.label')).toHaveText(['Who took them out', 'Where they are now']);
    await expect(page.locator('.mname')).toHaveText(['Tavrik', 'Paid in again', 'In their own files', 'Found elsewhere, owner unknown', 'Not found']);
    await expect(page.locator('.mrow').first().locator('.badge')).toHaveText('Proven');
    await expect(page.locator('.mrow').last().locator('.badge')).toHaveText('Estimate');
    await shot('flow');
  });

  test('a part shows its records and findings; a market links to its screen', async () => {
    await node('Diamond market').click();
    await expect(page.locator('.dtitle')).toHaveText('Diamond market');
    await expect(page.getByRole('link', { name: 'Open the diamond market' })).toHaveAttribute('href', /^#\/markets\/\d+$/);
    await expect(page.locator('.detail')).toContainText('Findings about it');
    await page.getByRole('button', { name: /^Show the [\d']+ records$/ }).click();
    await expect(page.locator('.scroll tbody tr').first()).toBeVisible();
    await expect(page.locator('.scroll table').first().locator('tbody tr')).toHaveCount(10);
    await page.locator('.detail').screenshot({ path: 'test-results/flow-market-dark.png' });
    await page.locator('section.card', { hasText: 'The records behind' }).screenshot({ path: 'test-results/flow-records-dark.png' });
    await node('Spent on items').click();
    await expect(page.locator('.dright h3.label')).toHaveText(['Made of', 'What the goods are worth now']);
    await expect(page.locator('.mname')).toContainText(['Coal', 'Worth about, at the usual price']);
  });

  test('the player switch follows one player only', async () => {
    const group = page.getByRole('group', { name: 'Whose money to follow' });
    await expect(group.getByRole('button')).toHaveText(['Both players', 'Ombrelune', 'Tavrik']);
    await group.getByRole('button', { name: 'Ombrelune' }).click();
    await expect(group.getByRole('button', { name: 'Ombrelune' })).toHaveAttribute('aria-pressed', 'true');
    await expect(node('Tavrik')).toHaveCount(0);
    await expect(node('Ombrelune')).toHaveCount(1);
    await expect(node('Notes paid in')).toHaveCount(1);
    // Her diamond gain is under 1% of her money, yet the answer names that market, so it stays on its own.
    await expect(page.locator('.lead')).toHaveText(/^Of the \$[\d.]+M Ombrelune had or got since the incident's start \(\$18'136\.10 of it made on the diamond market\), \$4\.12M is still in the bank\.$/);
    await expect(node('Diamond market')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/flow-player-dark.png' });

    // One player: the notes still outside split only into their own files and the rest.
    await group.getByRole('button', { name: 'Tavrik' }).click();
    await node('Taken out as notes').click();
    await expect(page.locator('.mname')).toHaveText(['Tavrik', 'In their own files', 'Not in their own files']);
    await expect(page.locator('.mrow').last()).toContainText('pick All players to see where the rest may be');
    await page.locator('.detail').screenshot({ path: 'test-results/flow-player-notes-dark.png' });
    await group.getByRole('button', { name: 'Both players' }).click();
    await expect(node('Tavrik')).toHaveCount(1);
  });

  test('at 900 px a player name of 16 letters shows in full, a longer one is cut', async () => {
    await page.setViewportSize({ width: 900, height: 900 });
    const fits = (name: string) => page.locator('.node .nname').filter({ hasText: /^Tavrik$/ }).evaluate((e, n) => {
      const was = e.textContent;
      e.textContent = n;
      const ok = e.scrollWidth <= e.clientWidth;
      e.textContent = was;
      return ok;
    }, name);
    expect(await fits('MightyWombat_916')).toBe(true); // 16 letters, the longest Minecraft name
    expect(await fits('MightyWombat_916_and_more')).toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
  });
});

test.describe('an old 2.1.2 save', () => {
  test.beforeAll(() => launch('legacy', [fx.legacy]));
  test.afterAll(() => program.close());

  test('what 2.1.2 did not log is an estimate, and the screen says so', async () => {
    await expect(node('Likely notes paid in')).toHaveCount(1);
    await expect(node('Added, no log row')).toHaveCount(1);
    await expect(node('Taken out as notes').locator('.namount')).toHaveText(/^about /);
    await expect(page.locator('.notes')).toContainText('2.1.2 logged no admin action');
    await shot('flow-legacy');
  });
});

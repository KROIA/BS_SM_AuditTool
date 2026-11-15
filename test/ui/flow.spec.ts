// Item flow on the invented network with Tavrik's extra money (FLOW): the answer first, the three
// columns, the player switch, a picked part with its records, another item instead of the money, the timeline with its
// items and trades, and the 2.1.2 save's estimates. Screenshots land in test-results/.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildFixtures, ITEM, PLAYERS, SHARED, T0, uuidText } from '../fixtures/build.ts';

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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Item flow');
}
const nonMoney = () => page.getByRole('checkbox', { name: 'Non-money items' });
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
    await expect(page.locator('.lead')).toHaveText("Of the 15.33M $ these players had or got since the incident's start (5.46M $ of it made on the diamond market), 10.32M $ is still in the bank, 4M $ was taken out as banknotes and 1M $ was sent to other accounts.");

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
    await expect(page.locator('.dright h3.label')).toHaveText(['Made of', 'What the goods are worth']);
    await expect(page.locator('.mname')).toContainText(['Coal', 'Worth about, at the usual price']);
    await expect(page.locator('.detail')).toContainText("at each market's usual price before the incident");
    await page.locator('.detail').screenshot({ path: 'test-results/flow-items-dark.png' });
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
    await expect(page.locator('.lead')).toHaveText(/^Of the [\d.]+M \$ Ombrelune had or got since the incident's start \(18'136\.10 \$ of it made on the diamond market\), 4\.12M \$ is still in the bank\.$/);
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

  test('Bank accounts splits the middle column into the players\' accounts (AT-59)', async () => {
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Bank accounts' }).click();
    await expect(node(`Account ${PLAYERS.Tavrik.account} · Tavrik`)).toHaveCount(1);
    await expect(node('Tavrik')).toHaveCount(0);
    await node(`Account ${PLAYERS.Tavrik.account} · Tavrik`).click();
    await expect(page.getByRole('link', { name: `Open account ${PLAYERS.Tavrik.account}` })).toHaveAttribute('href', `#/accounts/${PLAYERS.Tavrik.account}`);
    await page.screenshot({ path: 'test-results/flow-accounts-dark.png' });
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Players' }).click();
    await expect(node('Tavrik')).toHaveCount(1);
  });

  test('non-money items: the incident chart follows another item in its own count (AT-65)', async () => {
    await expect(page.getByRole('combobox', { name: 'Item', exact: true })).toHaveCount(0);
    await nonMoney().check();
    const item = page.getByRole('combobox', { name: 'Item', exact: true });
    await expect(item.locator('option').first()).toHaveText('Money ($)');
    await expect(item.locator('option').nth(1)).toHaveText('Diamond'); // the incident's market before the rest
    await item.selectOption({ label: 'Diamond' });
    await expect(page.locator('.lead')).toHaveText(/^Of the [\d']+ Diamond these players had or got since the incident's start, [\d']+ Diamond was sold on the market\.$/);
    await expect(node('Sold on the market')).toHaveCount(1);
    await expect(node('Taken out as notes')).toHaveCount(0);
    await expect(page.locator('.namount').first()).toHaveText(/^[\d']+ Diamond$/);
    await expect(page.locator('.notes')).toContainText('has no balance snapshot before the incident');
    await shot('flow-item');
    await item.selectOption({ label: 'Money ($)' });
    await nonMoney().uncheck();
    await expect(node('Taken out as notes')).toHaveCount(1);
  });
});

test.describe('the timeline', () => {
  // Tavrik pays 2M $ of notes into the shared account a minute after taking 2M $ out of his own (minute 51).
  test.beforeAll(() => {
    const save = path.resolve('test-results/fixtures-flow/carried');
    fs.rmSync(save, { recursive: true, force: true });
    fs.cpSync(fx.master, save, { recursive: true });
    const db = new DatabaseSync(path.join(save, 'data/BankSystem/Database/banksystem.db'));
    db.prepare(`INSERT INTO TransactionLog (account_number, actor_uuid, actor_name, kind, type_code, item_id, amount, ts, source_kind)
      VALUES (?, ?, 'Tavrik', 'DEPOSIT', 1, ?, 200000000, ?, 'PLAYER')`).run(SHARED.account, uuidText(PLAYERS.Tavrik.n), ITEM.money, T0 + 52 * 60_000);
    db.close();
    return launch('timeline', [save]);
  });
  test.afterAll(() => program.close());

  test('notes carried from one account into another run through the world', async () => {
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Timeline' }).click();
    await expect(page.locator('.lead')).toContainText('2M $ likely went from one account to another as banknotes, each time carried by the same player.');
    const rows = page.getByRole('group', { name: 'Rows on the chart' }).getByRole('button');
    await expect(rows.filter({ hasText: /^Tavrik$/ })).toHaveCount(1);
    await expect(rows.filter({ hasText: `Account ${SHARED.account} · ${SHARED.name}` })).toHaveCount(1); // a shared account keeps its own row
    await expect(rows.filter({ hasText: 'World: notes outside the bank' })).toHaveAttribute('aria-pressed', 'true');

    // The arrow keys step through the moves; the carried one opens with both log entries.
    const plot = page.getByRole('img', { name: /^Money moves from / });
    await plot.focus();
    for (let i = 0; i < 200 && !(await page.locator('.dtitle').allTextContents()).includes('Carried as notes'); i++) await plot.press('ArrowRight');
    await expect(page.locator('.dtitle')).toHaveText('Carried as notes');
    await expect(page.locator('.dtext')).toContainText(`left account ${PLAYERS.Tavrik.account} as banknotes and the same amount was paid into account ${SHARED.account} 1 min later, by the same player, Tavrik.`);
    await expect(page.locator('.detail .badge')).toHaveText('Estimate');
    await expect(page.locator('.detail tbody tr')).toHaveCount(2);
    await expect(page.locator('g.band path.dash')).not.toHaveCount(0);
    // Straight pieces only, no curves (their slanted flat ends looked like corners), and one arrowhead per band.
    expect(await page.locator('g.band path:not(.head)').evaluateAll((l) => l.every((p) => /^M[\d.-]+ [\d.-]+[VH][\d.-]+$/.test(p.getAttribute('d')!)))).toBe(true);
    expect(await page.locator('g.band path.head').count()).toBe(await page.locator('g.band').count());
    // The carried notes end with an arrow pointing up from the World row into the shared account: tip above the base.
    const [head] = await page.locator('g.band:has(path.dash) path.head').evaluateAll((l) => l.map((p) => p.getAttribute('d')!.match(/-?[\d.]+/g)!.map(Number)));
    expect(head![5]).toBeLessThan(head![1]);
    await shot('flow-timeline');

    // The time only zooms; Ctrl+Space shows everything again.
    const label = await plot.getAttribute('aria-label');
    await plot.hover();
    await page.mouse.wheel(0, -500);
    await expect(plot).not.toHaveAttribute('aria-label', label!);
    // All the way in, the axis counts milliseconds, and more wheel steps leave the time where it is (no sideways slide).
    for (let i = 0; i < 250; i++) await page.mouse.wheel(0, -200);
    const ticks = page.locator('.xaxis span');
    await expect(ticks.first()).toHaveText(/:\d\d\.\d{3}$/);
    const atMax = await ticks.allTextContents();
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -200);
    await expect(ticks).toHaveText(atMax);
    await plot.press('Control+Space');
    await expect(plot).toHaveAttribute('aria-label', label!);
  });

  test('Bank accounts gives every account its own row; a hidden row hides its moves', async () => {
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Bank accounts' }).click();
    const rows = page.getByRole('group', { name: 'Rows on the chart' }).getByRole('button');
    await expect(rows.filter({ hasText: /^Tavrik$/ })).toHaveCount(0);
    await expect(rows.filter({ hasText: new RegExp(`^Account ${PLAYERS.Tavrik.account} · `) })).toHaveCount(1);
    await page.screenshot({ path: 'test-results/flow-timeline-accounts-dark.png' });
    await page.getByRole('button', { name: 'Hide all rows' }).click();
    await expect(page.locator('.lead')).toHaveText('No money moved between the rows shown in this time range.');
    await page.getByRole('button', { name: 'Show all rows' }).click();
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Players' }).click();
  });

  test('non-money items: a second list, item colours, and a trade with both sides drawn as one (AT-65)', async () => {
    await expect(page.getByRole('group', { name: 'Items on the chart' })).toHaveCount(0);
    await nonMoney().check();
    const items = page.getByRole('group', { name: 'Items on the chart' }).getByRole('button');
    await expect(items.first()).toHaveText('Money ($)');
    await expect(items.filter({ hasText: /^Diamond$/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Rows on the chart' }).getByRole('button').filter({ hasText: 'World: outside the bank' })).toHaveCount(1);
    await expect(page.locator('path.trade')).not.toHaveCount(0);
    await expect(page.locator('.lead')).toContainText(/both sides, marked with a diamond on the Markets row\.$/);
    await expect(page.locator('.legend')).toContainText('The colour shows the item');
    // A trade: two arrows, one head each, and the detail names both sides.
    expect(await page.locator('g.band path.head').count()).toBe(await page.locator('g.band').count());
    const plot = page.getByRole('img', { name: /^Moves from / });
    await plot.focus();
    for (let i = 0; i < 300 && !/ on the markets$/.test((await page.locator('.dtitle').allTextContents())[0] ?? ''); i++) await plot.press('ArrowRight');
    await expect(page.locator('.dtitle')).toHaveText(/^(Bought|Sold) on the markets$/);
    await expect(page.locator('.dtext')).toContainText(/(bought|sold) [\d'.]+ \w+ for [\d'.]+ \$ on the markets: the money/i);
    await shot('flow-timeline-items');
    // The money alone again: no trade marks, colours by kind.
    await page.getByRole('button', { name: 'Hide all items' }).click();
    await items.first().click();
    await expect(page.locator('path.trade')).toHaveCount(0);
    await expect(page.locator('.legend')).toContainText('Transfer');
    await nonMoney().uncheck();
    await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Incident' }).click();
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

  test('notes another player likely paid in get a row of their own (AT-41)', async () => {
    // The 1.5M $ that appeared on Brindle's account is exactly what Tavrik took out at minute 51.
    await page.getByRole('group', { name: 'Whose money to follow' }).getByRole('button', { name: 'Tavrik' }).click();
    await node('Taken out as notes').click();
    await expect(page.locator('.mname')).toHaveText(['Tavrik', 'Paid in again', 'Likely paid in by Brindle', 'In their own files', 'Not in their own files']);
    await expect(page.locator('.mrow', { hasText: 'Likely paid in by Brindle' })).toContainText("1'500'000.00 $");
    await expect(page.getByRole('link', { name: 'Likely paid in by Brindle' })).toHaveAttribute('href', `#/players/${encodeURIComponent(uuidText(PLAYERS.Brindle.n))}`);
    await page.locator('.detail').screenshot({ path: 'test-results/flow-legacy-likely-dark.png' });
  });
});

// The Findings screen on the invented network: the list, the picked finding, pins, dismissals and notes kept in case.json,
// and the detection rules. Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, PLAYERS, T0, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-findings'));
const data = path.resolve('test-results/app-data-findings');
const PROFIT = `hour-profit:${uuidText(PLAYERS.Tavrik.n)}@${T0}`;
const FLAG = 'bank-flag:3';
let program: ElectronApplication;
let page: Page;

async function launch(open: string[]) {
  program = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  page = await program.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
}
const item = (id: string) => page.locator(`a.item[href="#/findings/${encodeURIComponent(id)}"]`);
const detail = () => page.getByRole('region', { name: 'Selected finding' });

test.beforeAll(async () => {
  fs.rmSync(data, { recursive: true, force: true });
  await launch([fx.master, ...fx.slaves]);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
});
test.afterAll(() => program.close());

test('the list: grouped into incidents, the severity chips filter it, dark and light', async () => {
  await page.evaluate("location.hash = '#/findings'");
  // 15, the five transfer findings (fixtures, TRANSFER_CASES; none joins an incident), four market alerts (three join) and
  // the banknote count (AT-35, alone).
  await expect(page.locator('.sub').first()).toHaveText(/^25 findings in this time range\. 11 of them belong to 2 incidents\.$/);
  await expect(page.locator('.group h2')).toHaveText(['Incident: Tavrik on the diamond market', 'Incident: Quenby on the emerald market', 'Not part of an incident']);
  await expect(detail().locator('h2')).toHaveText(/trading profit within one hour/); // the first of the strongest incident
  await page.screenshot({ path: 'test-results/findings-dark.png' });
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await page.screenshot({ path: 'test-results/findings-light.png' });
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();

  await page.getByRole('button', { name: /^Critical \d/ }).click();
  await expect(page.locator('.item .dot')).not.toHaveCount(0);
  for (const dot of await page.locator('.item .dot').all()) await expect(dot).toHaveAttribute('style', /--crit/);
  await page.getByRole('button', { name: /^All \d/ }).click();
});

test('each finding has its own address, and back and forward follow it', async () => {
  await item(PROFIT).click();
  await expect(page).toHaveURL(new RegExp(`#/findings/${encodeURIComponent(PROFIT)}$`));
  await expect(detail()).toContainText('Measured here:');
  await expect(detail().getByRole('link', { name: 'Tavrik' })).toHaveAttribute('href', `#/players/${encodeURIComponent(uuidText(PLAYERS.Tavrik.n))}`);
  await item(FLAG).click();
  await expect(item(FLAG)).toHaveAttribute('aria-current', 'true');
  await page.goBack();
  await expect(item(PROFIT)).toHaveAttribute('aria-current', 'true');
  await expect(detail().locator('h2')).toHaveText(/trading profit within one hour/);
  await page.goForward();
  await expect(item(FLAG)).toHaveAttribute('aria-current', 'true');
});

test('a pin, a dismissal with its reason and a note survive a restart', async () => {
  await item(PROFIT).click();
  await detail().getByRole('button', { name: 'Pin to the case' }).click();
  await expect(page.getByRole('link', { name: 'Case: 1 pinned' })).toBeVisible();
  // From the keyboard: the form takes the focus, and Escape closes it without saving.
  await detail().getByRole('button', { name: 'Add a note' }).focus();
  await page.keyboard.press('Enter');
  await expect(detail().getByLabel('Note')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(detail().locator('form')).toHaveCount(0);
  await detail().getByRole('button', { name: 'Add a note' }).click();
  await detail().getByLabel('Note').fill('Sold the whole stock at once.');
  await detail().getByRole('button', { name: 'Save the note' }).click();
  await expect(item(PROFIT).getByRole('img', { name: 'Pinned to the case' })).toBeVisible();

  await item(FLAG).click();
  await detail().getByRole('button', { name: 'Not a problem' }).click();
  await detail().getByLabel('Why is it not a problem? (optional)').fill('An admin testing the bank.');
  await detail().getByRole('button', { name: 'Mark as not a problem' }).click();
  await expect(detail()).toContainText('Marked as not a problem. An admin testing the bank.');
  await expect(item(FLAG)).toHaveCount(0); // hidden behind the switch, the detail stays
  await item(PROFIT).click();
  await expect(page.locator('.sub').first()).toHaveText(/^24 findings in this time range\./);

  await program.close();
  await launch([]); // the saves come back from case.json too
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview'); // the saves came back
  await page.evaluate(`location.hash = '#/findings/${encodeURIComponent(PROFIT)}'`);
  await expect(page.getByRole('link', { name: 'Case: 1 pinned' })).toBeVisible();
  await expect(detail().getByRole('button', { name: 'Pinned to the case' })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail()).toContainText('Note: Sold the whole stock at once.');
  await expect(item(FLAG)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Show the 1 marked as not a problem' }).check();
  await item(FLAG).click();
  await expect(detail()).toContainText('Marked as not a problem. An admin testing the bank.');
  await page.screenshot({ path: 'test-results/findings-marks-dark.png' });
});

test('after a threshold change in the rules, the pinned finding stays as "not raised with the current settings"', async () => {
  await page.getByRole('link', { name: 'Detection rules' }).click();
  await expect(page).toHaveURL(/#\/findings\/rules$/);
  const field = page.getByLabel('Profit in one hour, above $');
  await field.fill('nothing');
  await field.press('Enter');
  await expect(page.getByText('Enter a number above 0, with at most two decimals.')).toBeVisible();
  await field.fill("10'000'000"); // Tavrik made 5.44M $
  await field.press('Enter');
  await expect(page.getByText('Enter a number above 0, with at most two decimals.')).toHaveCount(0);
  await expect(page.locator('.group h2').last()).toHaveText('Not raised with the current settings');
  await expect(item(PROFIT)).toContainText('trading profit within one hour'); // its stored title
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.screenshot({ path: 'test-results/findings-rules-dark.png' });
  await page.setViewportSize({ width: 1440, height: 900 });

  await item(PROFIT).click();
  await expect(detail()).toContainText('The rules no longer raise this finding');
  await expect(detail()).toContainText('Note: Sold the whole stock at once.');
  await page.screenshot({ path: 'test-results/findings-orphan-dark.png' });

  await page.evaluate("location.hash = '#/findings/rules'");
  await field.fill("1'000'000");
  await field.press('Enter');
  await expect(page.locator('.group h2').last()).toHaveText('Not part of an incident');
});

test('a market alert: raised by the server, the rule in its own words, the orders behind it', async () => {
  await page.evaluate(`location.hash = '#/findings/${encodeURIComponent('market-alert:1')}'`);
  await expect(detail()).toContainText('Raised by the market mod on the server');
  await expect(detail()).toContainText("a rise of 24.99%, the server's limit is 20%");
  await expect(detail()).toContainText('Tavrik pushed the diamond price up into own sell orders'); // the server log line
  await expect(detail().getByRole('link', { name: 'Change this rule' })).toHaveCount(0); // the server's thresholds, not ours
  await page.screenshot({ path: 'test-results/findings-alert-dark.png' });
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await page.screenshot({ path: 'test-results/findings-alert-light.png' });
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await page.evaluate(`location.hash = '#/findings/${encodeURIComponent('market-alert:4')}'`);
  await expect(detail()).toContainText('without a price for that minute the percent is unknown');
});

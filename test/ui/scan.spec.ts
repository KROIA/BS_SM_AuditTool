// The World scan tab of Saves and servers and the Banknotes and items tab of Players (AT-37), on the invented network: the
// count before and after the region scan run from its button in the built program (so the worker file in dist/ is used),
// the places found, the offers apart, the server filter; a player with notes, one without a file, and the old 2.1.2 save.
// Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, PLAYERS, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-scan'));
let program: ElectronApplication;
let page: Page;

async function launch(name: string, open: string[]) {
  const data = path.resolve(`test-results/app-data-scan-${name}`);
  fs.rmSync(data, { recursive: true, force: true });
  const app = await electron.launch({ args: ['.', ...open.flatMap((s) => ['--open', s])], env: { ...process.env, AUDIT_TOOL_DATA: data } });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1440, height: 900 });
  await expect(win.getByRole('heading', { level: 1 })).toHaveText('Overview'); // opens once the saves are loaded
  return [app, win] as const;
}
const player = (name: keyof typeof PLAYERS) => `#/players/${uuidText(PLAYERS[name].n)}`;
async function shoot(file: string, width = 1440) {
  await page.setViewportSize({ width, height: 1500 });
  await page.screenshot({ path: `test-results/${file}.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe('the invented network', () => {
  test.beforeAll(async () => {
    [program, page] = await launch('network', [fx.master, ...fx.slaves]);
  });
  test.afterAll(() => program.close());

  test('before the scan: the count from the player files, and the scan not run', async () => {
    await page.evaluate("location.hash = '#/saves/scan'");
    await expect(page.getByRole('tab', { name: 'World scan' })).toHaveAttribute('aria-selected', 'true');
    // The fixtures' count (WORLD): 980'962.00 should be outside, the player files hold 806'240.00.
    await expect(page.locator('.lead')).toHaveText("$980'962.00 in banknotes should be outside the bank; $806'240.00 was found, so $174'722.00 was not found.");
    await expect(page.locator('.tile .tlabel')).toHaveText(['Withdrawn as banknotes', 'Paid back in', 'Made or destroyed outside the bank', 'Should be outside the bank', 'Found', 'Not found']);
    // Full amounts in every tile, so they add up on screen.
    await expect(page.locator('.tile .tvalue')).toHaveText(["$4'003'050.00", "-$3'023'000.00", '+$912.00',"$980'962.00", "$806'240.00", "$174'722.00"]);
    const scan = page.getByRole('region', { name: 'Region scan' });
    await expect(scan).toContainText('Chests, other blocks and entities have not been looked at yet. The region scan reads the 5 region files');
    await expect(page.getByRole('region', { name: 'Where the tool could not look' })).toContainText('The region scan has not been run.');
    // Players without a file are named; the renamed note in Quenby's inventory is refused by the bank.
    await expect(page.getByRole('region', { name: 'Where the tool could not look' })).toContainText('Tavrik');
    await expect(page.getByRole('region', { name: 'Where the tool could not look' })).toContainText('Ombrelune');
    await expect(page.getByRole('region', { name: 'Where the tool could not look' })).toContainText('1 note with a custom name or other changes');
    await expect(page.getByRole('link', { name: 'Open the finding' })).toBeVisible();
    await shoot('scan-before-dark');
  });

  // The start call answers "running"; only the scan's progress events, through engine, main and preload, can say it ended.
  test('the scan runs from its button in the background, its progress reaches the screen, and the count follows', async () => {
    const scan = page.getByRole('region', { name: 'Region scan' });
    await scan.getByRole('button', { name: 'Start the region scan' }).click();
    await page.getByRole('link', { name: 'Overview', exact: true }).click(); // the scan runs in the background
    await page.evaluate("location.hash = '#/saves/scan'");
    await expect(scan).toContainText('Every region file was read: 5 files', { timeout: 30_000 });
    await expect(scan.getByRole('button')).toHaveCount(0); // nothing left to start
    // Blocks and entities add 32'940.00 (SCAN.blocks); the villager's offers (320.00) are prices and not counted.
    await expect(page.locator('.lead')).toHaveText("$980'962.00 in banknotes should be outside the bank; $839'180.00 was found, so $141'782.00 was not found.");
    const found = page.getByRole('region', { name: 'Where banknotes were found' });
    await expect(found.locator('.item')).toHaveCount(5); // the top five, then "Show all"
    await expect(found.locator('.item').first()).toContainText(/Ender chest of Quenby\s*survival-main, 7 notes of \$100'000\.00, partly in a shulker box\s*\$700'000\.00/);
    await expect(found).toContainText("Chest at the overworld, -884 28 -1'024");
    await expect(found).toContainText("survival-main, 20 notes of $1'000.00, also 64 Diamond");
    // Places with only valuables wait behind one line; "Show all" counts the rows with notes.
    await expect(found).not.toContainText('Barrel at vaultmod:deep_vault');
    await found.getByRole('button', { name: /^Show all/ }).click();
    await expect(found).toContainText("Bank terminal at the overworld, -876 64 -1'018");
    await expect(found).toContainText("Quenby's slots");
    await expect(found.locator('.item').filter({ hasText: 'no notes' })).toHaveCount(0);
    await expect(found.locator('.more')).toContainText('4 more places hold only valuables'); // the vault barrel, Mikko_82's wheat, the villager's wheat, the armor stand
    await found.getByRole('button', { name: 'Show them' }).click();
    await expect(found).toContainText('Barrel at vaultmod:deep_vault');
    await expect(found).toContainText("1'024 Diamond");
    const offers = page.getByRole('region', { name: "Prices in villagers' offers" });
    await expect(offers).toContainText("the $320.00 named here are not counted");
    await expect(offers).toContainText("Offers of a villager at the overworld, -881 64 -1'011");
    await expect(page.getByRole('region', { name: 'Where the tool could not look' })).toContainText('Could not be read: 2 chunks damaged, 1 chunk packed with LZ4');
    await shoot('scan-after-dark');
    await shoot('scan-after-narrow-dark', 900);
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await shoot('scan-after-light');
    await shoot('scan-after-narrow-light', 900);
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  });

  test('the finding says the same as the screen', async () => {
    await page.getByRole('link', { name: 'Open the finding' }).click();
    await expect(page.locator('main')).toContainText("The bank's log says $980'962.00 in banknotes should be outside the bank; $839'180.00 was found.");
    await expect(page.locator('main')).toContainText('every region file');
  });

  test('the server filter keeps the places and players\' items of one server; the count stays for the network', async () => {
    await page.evaluate("location.hash = '#/saves/scan'");
    await page.getByRole('button', { name: 'Server: all servers' }).click();
    await page.locator('#server-menu').getByRole('button', { name: /^mining-1/ }).click();
    const found = page.getByRole('region', { name: 'Where banknotes were found' });
    await expect(found.locator('.item')).toHaveCount(1);
    await expect(found.locator('.item')).toContainText(/Ender chest of Mikko_82\s*mining-1, 1 note of \$100'000\.00/);
    await expect(page.locator('main')).toContainText('Only what was found on mining-1 is listed.');
    await expect(page.locator('.lead')).toContainText("$839'180.00 was found");
    await page.getByRole('button', { name: 'Server: mining-1' }).click();
    await page.locator('#server-menu').getByRole('button', { name: 'All servers' }).click();
  });

  test('Players, Banknotes and items: a player with notes, and one without a file', async () => {
    await page.evaluate(`location.hash = '${player('Quenby')}'`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quenby');
    await page.getByRole('tab', { name: 'Banknotes and items' }).click();
    const carried = page.getByRole('region', { name: 'Found on the player' });
    await expect(carried.locator('.nrow')).toHaveCount(3);
    await expect(carried).toContainText(/Ender chest on survival-main\s*7 notes of \$100'000\.00, partly in a shulker box\s*\$700'000\.00/);
    await expect(carried).toContainText(/Inventory on survival-main\s*30 notes of \$100\.00, also 64 Diamond, partly in a bundle\s*\$3'000\.00/);
    await expect(carried).toContainText(/Slots at a bank terminal at the overworld, -876 64 -1'018\s*survival-main, 10 notes of \$100\.00/);
    const notes = page.getByRole('region', { name: 'Banknotes' });
    await expect(notes.locator('.nrow').first()).toContainText('Withdrawn as banknotes');
    await expect(notes.locator('.nrow').last()).toContainText('Still outside the bank, if nobody else used them');
    await expect(notes).toContainText('They are estimates.');
    await shoot('players-notes-dark');
    await page.evaluate(`location.hash = '${player('Tavrik')}'`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tavrik');
    await expect(carried.locator('.where')).toHaveText('What Tavrik carries is unknown: no loaded save has a player file for them.');
    await page.evaluate(`location.hash = '${player('Ombrelune')}'`);
    await expect(carried.locator('.where')).toHaveText('What Ombrelune carries is unknown: the player file could not be read.');
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await shoot('players-notes-light');
    await shoot('players-notes-narrow-light', 900);
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  });
});

test.describe('an old 2.1.2 save', () => {
  test.beforeAll(async () => {
    [program, page] = await launch('legacy', [fx.legacy]);
  });
  test.afterAll(() => program.close());

  test('the count matches what was found, and the player\'s notes are in the inventory', async () => {
    await page.evaluate("location.hash = '#/saves/scan'");
    await expect(page.locator('.lead')).toHaveText("$500'000.00 in banknotes should be outside the bank, and exactly that was found.");
    await expect(page.getByRole('region', { name: 'Region scan' })).toContainText('The loaded saves have no region files');
    await page.evaluate(`location.hash = '${player('Tavrik')}'`);
    await page.getByRole('tab', { name: 'Banknotes and items' }).click();
    await expect(page.getByRole('region', { name: 'Found on the player' })).toContainText(/Inventory on \S+\s*5 notes of \$100'000\.00\s*\$500'000\.00/);
    await expect(page.getByRole('region', { name: 'Banknotes' })).toContainText('Withdrawn as banknotes');
    await shoot('players-notes-legacy-dark');
  });
});

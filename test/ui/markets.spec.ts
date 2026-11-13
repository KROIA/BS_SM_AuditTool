// The Markets screen with the invented network and with the old 2.1.2 save, in both themes.
// Screenshots land in test-results/ to be looked at.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixtures, PLAYERS, uuidText } from '../fixtures/build.ts';

const fx = buildFixtures(path.resolve('test-results/fixtures-markets'));
const TAVRIK = uuidText(PLAYERS.Tavrik.n);

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
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-markets'), [fx.master, ...fx.slaves])));
  test.afterAll(() => program.close());

  test('the list: most findings first, then the largest swing; the first one opens with its facts and what stands out', async () => {
    await page.getByRole('link', { name: 'Markets', exact: true }).click();
    // Diamond 5 findings, Emerald 2, Coal 1 (an order and the bank log disagree), then the swing order.
    await expect(page.locator('aside .pick .ellipsis')).toHaveText(['Diamond', 'Emerald', 'Coal', 'Gold ingot', 'Wheat', 'Oak log', 'Iron ingot', 'Redstone']);
    await expect(page.locator('aside')).toContainText('most findings first');
    await expect(page.locator('aside .pick .dot')).toHaveCount(3);
    await expect(page.locator('aside .pick').first()).toContainText(/60 orders · \$52\.92\s*40\.91×/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diamond');
    await expect(page.locator('.lead')).toHaveText('In this time range the highest price was 40.91× the lowest.');
    await expect(page.locator('.mvalue')).toHaveText(['$52.70', '$48.36', "$1'978.42", "390'669", '1', '$52.92']);
    const standouts = page.getByRole('region', { name: 'What stands out' }).locator('a.link-row');
    await expect(standouts).toHaveCount(5);
    await expect(standouts.first()).toContainText('$5.44M trading profit within one hour');
    await expect(standouts.last()).toContainText("The diamond price swung between $329.74 and $1'978.42 inside one minute");
    await standouts.last().click();
    await expect(page).toHaveURL(/#\/findings\/price-spike%3A/);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diamond');
  });

  test('the chart: a fitting candle length, other lengths, scale, readout and zoom', async () => {
    const lengths = page.getByRole('group', { name: 'Candle length' });
    await expect(lengths.getByRole('button', { name: '1 min' })).toHaveAttribute('aria-pressed', 'true'); // 160 minutes fit
    await expect(page.getByRole('img', { name: 'Price of Diamond in candles of 1 min' })).toBeVisible();
    await expect(page.locator('.readout')).toContainText('Close not known yet'); // the newest candle
    await expect(page.locator('main')).toContainText('The bot\'s own orders cannot be shown.');

    await lengths.getByRole('button', { name: '1 hour' }).click();
    await expect(page.getByRole('img', { name: 'Price of Diamond in candles of 1 hour' })).toBeVisible();
    const plot = page.locator('.plot');
    const box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width / 6, box.y + 100); // the first of three hour candles
    await expect(page.locator('.readout')).toContainText("Open $49.74 High $1'978.42 Low $48.36 Close $50.17 Volume 143'248");

    await page.getByRole('group', { name: 'Price scale' }).getByRole('button', { name: 'Linear' }).click();
    await expect(page.locator('.yaxis')).toContainText('$');

    // Zoomed in, a new candle length is read for the span on screen only.
    await lengths.getByRole('button', { name: '1 min' }).click();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -200);
    await lengths.getByRole('button', { name: '5 min', exact: true }).click();
    await page.getByRole('button', { name: 'Show the whole time range' }).click();
    await expect(page.getByRole('button', { name: 'Show the whole time range' })).toHaveCount(0);
    await page.getByRole('group', { name: 'Price scale' }).getByRole('button', { name: 'Log' }).click();
  });

  test('who traded here: a picked player gets markers, the name opens the player', async () => {
    const lengths = page.getByRole('group', { name: 'Candle length' });
    await lengths.getByRole('button', { name: '1 min' }).click();
    await expect(page.locator('.trow')).toHaveCount(1);
    await expect(page.locator('.trow')).toContainText(/Tavrik\s*bought for \$440'370\.00, sold for \$5\.88M\s*\+\$5\.44M/);
    await expect(page.locator('main')).toContainText('Pick a player below to see their orders on the chart.');
    await page.getByRole('button', { name: 'Show on chart' }).click();
    await expect(page.locator('.mark')).toHaveCount(60);
    await expect(page.locator('.mark.buy')).toHaveCount(30);
    await expect(page.locator('.legend')).toContainText('Bought by Tavrik');
    await expect(page.locator('.legend')).toContainText('at the time it finished.');
    // Minute 21 holds the 30 buys: the readout names them.
    await page.locator('.plot').scrollIntoViewIfNeeded();
    const box = (await page.locator('.plot').boundingBox())!;
    await page.mouse.move(box.x + (box.width * 21.5) / 160, box.y + 100);
    await expect(page.locator('.readout')).toContainText("Tavrik bought 3'000 at $");
    await expect(page.locator('.readout')).toContainText('orders that finished in this candle');
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: 'test-results/markets-dark.png' });
    await page.getByRole('button', { name: 'Switch to the light theme' }).click();
    await page.screenshot({ path: 'test-results/markets-light.png' });
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.locator('.trow').getByRole('link', { name: 'Tavrik' }).click();
    await expect(page).toHaveURL(new RegExp(`#/players/${TAVRIK}$`));
  });

  test('market names on the Players screen open the market', async () => {
    await page.locator('.market').getByRole('link', { name: 'Diamond' }).click();
    await expect(page).toHaveURL(/#\/markets\/2$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Diamond');
    await page.goBack();
    await page.locator('tbody tr').first().getByRole('link', { name: 'Diamond' }).click();
    await expect(page).toHaveURL(/#\/markets\/2$/);
    await page.evaluate("location.hash = '#/markets/3'");
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Emerald');
    await expect(page.getByRole('region', { name: 'What stands out' }).locator('a.link-row')).toHaveCount(2);
    await page.evaluate("location.hash = '#/markets/5'");
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Gold ingot');
    await expect(page.getByRole('region', { name: 'What stands out' })).toContainText('Nothing unusual in this time range.');
  });
});

test.describe('an old 2.1.2 save', () => {
  let program: ElectronApplication;
  let page: Page;
  test.beforeAll(async () => ({ program, page } = await launch(path.resolve('test-results/app-data-markets-legacy'), [fx.legacy])));
  test.afterAll(() => program.close());

  test('markers sit where the orders were placed, and the legend says why', async () => {
    await page.getByRole('link', { name: 'Markets', exact: true }).click();
    await page.getByRole('button', { name: 'Show on chart' }).click();
    await expect(page.locator('.mark')).toHaveCount(60);
    await expect(page.locator('.legend')).toContainText('at the time it was placed: this save does not record when orders finished.');
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: 'test-results/markets-legacy-dark.png' });
  });
});

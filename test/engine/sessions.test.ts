import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { api } from '../../src/engine/api.ts';
import { median, usualPrice } from '../../src/engine/query/markets.ts';
import { profit } from '../../src/engine/query/profit.ts';
import { hourlyProfit, hours, sessions, split } from '../../src/engine/query/sessions.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import type { OrderRow, Scope } from '../../src/shared/api.ts';
import { buildFixtures, ITEM, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000, HOUR = 3_600_000;
const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
const uuid = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);

let id = 0;
/** An order of one invented player: + bought, - sold, money signed like the amount. */
const order = (time: number, amount: bigint, money: bigint, server = 'survival-main', item: number = ITEM.diamond): OrderRow => ({
  id: ++id, orderId: id, item, account: 1, player: 'p', type: 'market', amount, price: (money * 100n) / amount, money, time, finishMs: null, server, limitPrice: null, wanted: null, status: null,
});
const total = (list: OrderRow[]) => profit(list.map((o) => ({ item: o.item, amount: o.amount, money: o.money, counts: true }))).reduce((s, m) => s + m.profit, 0n);

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-sessions-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('a session ends at a gap of 5 minutes: 4:59 joins, 5:00 starts a new one', () => {
  const t = T0;
  const list = [order(t, 100n, 1000n), order(t + 5 * MIN - 1000, 100n, 1000n), order(t + 10 * MIN - 1000, 100n, 1000n), order(t + 10 * MIN - 999, 100n, 1000n)];
  const got = split(list, null);
  assert.deepEqual(got.map((s) => [s.start, s.end, s.orders]), [[t, t + 5 * MIN - 1000, 2], [t + 10 * MIN - 1000, t + 10 * MIN - 999, 2]]);
  assert.deepEqual(got.map((s) => s.medianGapMs), [5 * MIN - 1000, 1]);
  assert.equal(split([order(t, 100n, 1000n)], null)[0]!.medianGapMs, null);
  assert.equal(median([40n, 10n, 30n, 20n]), 25n);
});

test('profit carries the average cost across sessions; sales without a purchase stay apart', () => {
  const list = [
    order(T0, 1000n, 1000n, 'survival-main'), // 10 bought for $10.00
    order(T0 + HOUR, -500n, -1500n, 'mining-1'), // 5 sold for $15.00: cost $5.00, profit $10.00
    order(T0 + 2 * HOUR, -1000n, -2000n, 'mining-1', ITEM.diamond), // 10 sold, only 5 held: profit $5.00, $10.00 without a purchase
    order(T0 + 2 * HOUR + MIN, 200n, 300n, 'survival-main', ITEM.coal),
  ];
  const got = split(list, null);
  assert.deepEqual(got.map((s) => [s.orders, s.profit, s.soldWithoutPurchase]), [[1, 0n, 0n], [1, 1000n, 0n], [2, 500n, 1000n]]);
  assert.deepEqual(got[2]!.markets, [ITEM.diamond, ITEM.coal]);
  assert.equal(got.reduce((s, x) => s + x.profit, 0n), total(list));
  // The buy on the master is not in a mining-1 session but still sets the cost of the sales there.
  assert.deepEqual(split(list, 'mining-1').map((s) => [s.orders, s.profit]), [[1, 1000n], [1, 500n]]);
});

test('profit per hour splits at the full hour in UTC', () => {
  const list = [order(T0, 3000n, 3000n), order(T0 + HOUR - 1, -1000n, -2000n), order(T0 + HOUR, -1000n, -3000n), order(T0 + HOUR + 1, -1000n, -500n)];
  assert.deepEqual([...hours(list, ALL)], [[T0, 1000n], [T0 + HOUR, 2000n - 500n]]);
  assert.deepEqual([...hours(list, { ...ALL, from: T0 + HOUR })], [[T0 + HOUR, 1500n]], 'earlier trades still set the cost');
});

test('on the fixtures, session and hourly profits add up to each player\'s realised profit', () => {
  open(fx.master);
  const players = api.players(ALL);
  const hourly = hourlyProfit(ALL);
  for (const p of players) {
    assert.equal(api.sessions(p.uuid, ALL).reduce((s, x) => s + x.profit, 0n), p.profit, p.name);
    assert.equal(hourly.filter((h) => h.player === p.uuid).reduce((s, h) => s + h.profit, 0n), p.profit, p.name);
  }
  const tavrik = api.sessions(uuid('Tavrik'), ALL);
  assert.deepEqual(tavrik.map((s) => [s.start, s.end, s.orders, s.markets, s.medianGapMs]), [
    [T0 + 21 * MIN, T0 + 21 * MIN + 580, 30, [ITEM.diamond], 20],
    [T0 + 40 * MIN, T0 + 40 * MIN + 580, 30, [ITEM.diamond], 20],
  ]);
  assert.equal(tavrik[0]!.profit, 0n);
  // A session counts when it overlaps the time range, and is given whole.
  assert.equal(api.sessions(uuid('Tavrik'), { ...ALL, from: T0 + 21 * MIN + 300 }).length, 2);
  assert.equal(api.sessions(uuid('Tavrik'), { ...ALL, from: T0 + 21 * MIN + 581 }).length, 1);
  assert.equal(api.sessions(uuid('Tavrik'), { ...ALL, to: T0 + 21 * MIN }).length, 1);
  assert.deepEqual(api.sessions(uuid('Tavrik'), { ...ALL, server: 'mining-1' }), []);
  assert.equal(api.sessions(uuid('Brindle'), { ...ALL, server: 'mining-1' }).length, 3);
});

test('the usual price over all data: median open of the minutes, else the median order price', () => {
  open(fx.master);
  for (const item of [ITEM.diamond, ITEM.coal]) assert.equal(usualPrice(item), api.market(item, ALL).usual);
  assert.equal(usualPrice(ITEM.diamond), usualPrice(ITEM.diamond));
  assert.equal(usualPrice(999), null);

  // The old save without its candles: the orders' prices decide.
  const copy = path.join(fx.root, 'no-candles');
  fs.cpSync(fx.legacy, copy, { recursive: true });
  const db = new DatabaseSync(path.join(copy, 'data/StockMarket/Database/stockdata.db'));
  db.exec('DELETE FROM MarketPrice');
  db.close();
  open(copy);
  const prices = api.orders({ item: ITEM.diamond }, ALL).map((o) => o.price);
  assert.equal(prices.length, 60);
  assert.equal(usualPrice(ITEM.diamond), median(prices));
  assert.equal(api.market(ITEM.diamond, ALL).usual, median(prices));
  assert.equal(usualPrice(ITEM.redstone), null, 'no candles and no orders');
});

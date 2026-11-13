// The usual price follows the market (AT-45): the median open of the last 1'440 minutes before the hour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { api } from '../../src/engine/api.ts';
import { median, usualAt, usualPrice } from '../../src/engine/query/markets.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, ITEM, T0, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000, H = 60 * MIN;
const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
const STOCK = 'data/StockMarket/Database/stockdata.db';
/** The opens of a market before a moment, newest first, read straight from the mod's table. */
const opensBefore = (save: string, item: number, t: number) => {
  const db = new DatabaseSync(path.join(save, STOCK), { readOnly: true });
  const rows = db.prepare('SELECT open FROM MarketPrice WHERE marketid = ? AND time < ? ORDER BY time DESC').all(item, t).map((r) => BigInt(r.open as number));
  db.close();
  return rows;
};

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-usual-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('fewer than 60 minutes before the hour: the usual price over all data; from 60 on, the minutes before the hour', () => {
  open(fx.master);
  // The fixture's minutes start at T0, on the hour: in the first hour none lie before it.
  assert.equal(usualAt(ITEM.diamond, T0 + 59 * MIN), usualPrice(ITEM.diamond));
  assert.equal(usualAt(ITEM.diamond, T0 - 5 * H), usualPrice(ITEM.diamond));
  const window = median(opensBefore(fx.master, ITEM.diamond, T0 + H));
  assert.equal(opensBefore(fx.master, ITEM.diamond, T0 + H).length, 60);
  assert.equal(usualAt(ITEM.diamond, T0 + 60 * MIN), window);
  assert.equal(usualAt(ITEM.diamond, T0 + 119 * MIN + 59_999), window, 'one value per hour');
  assert.notEqual(window, usualPrice(ITEM.diamond));
  assert.equal(usualAt(999, T0 + H), null, 'no candles and no orders');
});

test('a market that sat at the floor for long and then trades higher: far-price measures against the new level', () => {
  // A copy of the master: oak at 1 raw for 4'400 minutes, then 1'600 minutes at 80 raw before the fixture's own oak
  // minutes (about 80 raw). Over all data the median is 1 raw; the last day of trading says about 80.
  const save = path.join(fx.root, 'oak-floor');
  fs.cpSync(fx.master, save, { recursive: true });
  const db = new DatabaseSync(path.join(save, STOCK));
  const candle = db.prepare('INSERT INTO MarketPrice (marketid, open, low, high, time, traded_volume) VALUES (?, ?, ?, ?, ?, 1)');
  // An order of an existing player, so it has a known account and uuid.
  const order = db.prepare(`INSERT INTO OrderHistory (itemid, accountid, userid_one, userid_two, type, amount, price, time)
    SELECT ?, accountid, userid_one, userid_two, 0, 10, ?, ? FROM OrderHistory LIMIT 1`);
  db.exec('BEGIN');
  for (let i = 6000; i > 1600; i--) candle.run(ITEM.oak, 1, 1, 1, T0 - i * MIN);
  for (let i = 1600; i > 0; i--) candle.run(ITEM.oak, 80, 79, 81, T0 - i * MIN);
  order.run(ITEM.oak, 82, T0 + 90 * MIN); // at the new level: 82 times the all-data median, but not unusual now
  order.run(ITEM.oak, 2_400, T0 + 100 * MIN); // 30 times the new level
  db.exec('COMMIT');
  db.close();
  open(save);

  assert.equal(usualPrice(ITEM.oak), 1n);
  const level = median(opensBefore(save, ITEM.oak, T0 + H).slice(0, 1440));
  assert.ok(level! >= 75n && level! <= 85n, `the new level, ${level}`);
  const far = api.findings(ALL, DEFAULT_RULES).findings.filter((f) => f.rule === 'far-price' && f.markets[0] === ITEM.oak);
  assert.equal(far.length, 1);
  assert.deepEqual([far[0]!.facts.price, far[0]!.facts.usual, far[0]!.facts.orders, far[0]!.start], [2_400n, level, 1, T0 + 100 * MIN]);
  // The Markets screen's facts and chart line say the same at the end of the range and per candle.
  assert.equal(api.market(ITEM.oak, ALL).usual, median(opensBefore(save, ITEM.oak, Number.MAX_SAFE_INTEGER).slice(0, 1440)));
  // The chart's line, worked out in one read, is the slow way's median before each hour.
  const c = api.candles(ITEM.oak, 60, { from: T0 - 6000 * MIN, to: null, server: null });
  const every = opensBefore(save, ITEM.oak, Number.MAX_SAFE_INTEGER), times = (() => {
    const db = new DatabaseSync(path.join(save, STOCK), { readOnly: true });
    const t = db.prepare('SELECT time FROM MarketPrice WHERE marketid = ? ORDER BY time DESC').all(ITEM.oak).map((r) => Number(r.time));
    db.close();
    return t;
  })();
  assert.equal(c.usual.length, c.candles.length);
  assert.equal(c.usual[0], null, 'the first hour has nothing before it: no point, not the all-data fallback');
  c.candles.forEach((k, i) => {
    const before = every.filter((_, j) => times[j]! < k.time).slice(0, 1440);
    assert.equal(c.usual[i], before.length < 60 ? null : median(before), `hour ${i}`);
  });
});

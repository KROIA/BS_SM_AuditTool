import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import type { Candle, Scope } from '../../src/shared/api.ts';
import { buildFixtures, ITEM, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
/** Starts and ends inside an hour, so the 60- and 1440-minute candles need both the hour table and single minutes. */
const NARROW: Scope = { from: T0 + 30 * MIN + 5000, to: T0 + 130 * MIN + 10_000, server: null };
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
const uuid = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);

/** The 1-minute candles as the save holds them, read straight from the mod's table. */
function minutes(save: string, item: number, s: Scope) {
  const db = new DatabaseSync(path.join(save, 'data/StockMarket/Database/stockdata.db'), { readOnly: true });
  const rows = db.prepare('SELECT time, open, low, high, traded_volume AS volume FROM MarketPrice WHERE marketid = ? ORDER BY time').all(item)
    .map((r) => ({ time: Number(r.time), open: BigInt(r.open as number), low: BigInt(r.low as number), high: BigInt(r.high as number), volume: Number(r.volume) }));
  db.close();
  return { inScope: rows.filter((r) => (s.from === null || r.time >= s.from) && (s.to === null || r.time <= s.to)), every: rows };
}
/** The candles the engine should give, worked out the slow way: bucket every minute, close from the next minute after the bucket. */
function expected(save: string, item: number, interval: number, s: Scope): Candle[] {
  const { inScope, every } = minutes(save, item, s);
  const iv = interval * MIN, out: Candle[] = [];
  for (const r of inScope) {
    const t = Math.floor(r.time / iv) * iv, last = out.at(-1);
    if (last?.time === t) {
      last.high = r.high > last.high ? r.high : last.high;
      last.low = r.low < last.low ? r.low : last.low;
      last.volume += r.volume;
    } else out.push({ time: t, open: r.open, high: r.high, low: r.low, close: null, volume: r.volume });
  }
  for (const c of out) c.close = every.find((r) => r.time >= c.time + iv)?.open ?? null;
  return out;
}

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-markets-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('with nothing loaded the market questions answer empty', () => {
  init(path.join(fx.root, 'empty-workspace'));
  assert.deepEqual(api.markets(ALL), []);
  assert.deepEqual(api.market(ITEM.diamond, ALL), { usual: null, low: null, high: null, volume: 0, traders: 0 });
  assert.deepEqual(api.candles(ITEM.diamond, 60, ALL), { candles: [], capped: false, usual: [], span: null });
  assert.deepEqual(api.traders(ITEM.diamond, ALL), []);
});

test('candles of every length match the minutes added up, with close taken from the next open', () => {
  open(fx.master);
  for (const s of [ALL, NARROW])
    for (const m of [1, 5, 15, 60, 1440] as const) {
      const got = api.candles(ITEM.diamond, m, s);
      assert.equal(got.capped, false);
      assert.deepEqual(got.candles, expected(fx.master, ITEM.diamond, m, s), `${m} minutes, ${s === ALL ? 'everything' : 'narrow'}`);
    }
  const hours = api.candles(ITEM.diamond, 60, ALL).candles;
  assert.deepEqual(hours.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]), [
    [T0, 4974n, 197842n, 4836n, 5017n, 143248],
    [T0 + 60 * MIN, 5017n, 5341n, 4957n, 5217n, 155733],
    [T0 + 120 * MIN, 5217n, 5526n, 5195n, null, 91688], // the newest candle has no close
  ]);
  // A range that ends inside an hour: the last candle closes at the next minute's open, outside the range.
  const cut = api.candles(ITEM.diamond, 1, { from: T0, to: T0 + 9 * MIN, server: null }).candles;
  assert.equal(cut.length, 10);
  assert.equal(cut.at(-1)!.close, api.candles(ITEM.diamond, 1, ALL).candles[10]!.open);
});

test('at most the newest 5000 candles; capped says the range held more, span what it covers, end reads older parts', () => {
  // A copy of the master with 6000 more minutes of oak before the scenario.
  const save = path.join(fx.root, 'long-market');
  fs.cpSync(fx.master, save, { recursive: true });
  const db = new DatabaseSync(path.join(save, 'data/StockMarket/Database/stockdata.db'));
  const add = db.prepare('INSERT INTO MarketPrice (marketid, open, low, high, time, traded_volume) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 6000; i++) add.run(ITEM.oak, 100 + i, 90 + i, 110 + i, T0 - (6000 - i) * MIN, 1);
  db.exec('COMMIT');
  db.close();
  open(save);
  const one = api.candles(ITEM.oak, 1, ALL);
  assert.equal(one.capped, true);
  assert.equal(one.candles.length, 5000);
  const all1 = api.candles(ITEM.oak, 5, ALL).candles; // whole, for the times
  assert.deepEqual(one.span, { from: T0 - 6000 * MIN, to: all1.at(-1)!.time + 5 * MIN });
  assert.equal(one.candles.at(-1)!.close, null); // the newest candle of the save
  // Older ones: the 5000 up to an end, which close at the next open even past the end.
  const older = api.candles(ITEM.oak, 1, ALL, T0 - 1001 * MIN);
  assert.deepEqual([older.capped, older.candles.length, older.candles[0]!.time, older.candles.at(-1)!.time, older.candles.at(-1)!.close],
    [true, 5000, T0 - 6000 * MIN, T0 - 1001 * MIN, 5100n]);
  assert.deepEqual(older.span, one.span);
  // Read newest first, a 5-minute candle still opens at its first minute.
  assert.deepEqual(api.candles(ITEM.oak, 5, ALL, T0 - 1001 * MIN).candles.slice(0, 2).map((c) => [c.open, c.close]), [[100n, 105n], [105n, 110n]]);
  const five = api.candles(ITEM.oak, 5, ALL);
  assert.deepEqual([five.capped, five.candles.length], [false, 1232]); // 6000 + 160 minutes in 5-minute candles
});

test('markets: largest swing first, swing is the highest high over the lowest low', () => {
  open(fx.master);
  const list = api.markets(ALL);
  assert.deepEqual(list.map((m) => m.item), [ITEM.diamond, ITEM.emerald, ITEM.gold, ITEM.wheat, ITEM.oak, ITEM.coal, ITEM.iron, ITEM.redstone]);
  assert.deepEqual(list.map((m) => m.orders), [60, 20, 1, 2, 0, 2, 1, 0]);
  assert.equal(list[0]!.swing, 197842 / 4836);
  assert.equal(list[0]!.price, 5292n); // MarketManager's price from the market's file
  for (const m of list) {
    const { inScope } = minutes(fx.master, m.item, NARROW);
    const hi = inScope.reduce((a, r) => (r.high > a ? r.high : a), 0n), lo = inScope.reduce((a, r) => (r.low < a ? r.low : a), hi);
    assert.equal(api.markets(NARROW).find((x) => x.item === m.item)!.swing, Number(hi) / Number(lo), `item ${m.item}`);
  }
  // Brindle's orders were placed on mining-1: with that server picked, only coal and iron have orders.
  const mining = api.markets({ ...ALL, server: 'mining-1' });
  assert.deepEqual(mining.filter((m) => m.orders > 0).map((m) => [m.item, m.orders]), [[ITEM.coal, 2], [ITEM.iron, 1]]);
});

test('market facts: usual price at the end of the range is the median 1-minute open before it, low, high, volume and traders', () => {
  open(fx.master);
  assert.deepEqual(api.market(ITEM.diamond, ALL), { usual: 5270n, low: 4836n, high: 197842n, volume: 390669, traders: 1 });
  // NARROW ends at T0 + 130 minutes: the usual price is that of minutes 0 to 119, the last whole hours before it (AT-45).
  assert.deepEqual(api.market(ITEM.diamond, NARROW), { usual: 5213n, low: 4957n, high: 197842n, volume: 258712, traders: 1 });
  // The median the slow way: every minute before the hour the range ends in (all 160 of them, then minutes 0 to 119).
  for (const [s, before] of [[ALL, Infinity], [{ ...ALL, to: T0 + 158 * MIN }, T0 + 120 * MIN]] as const) {
    const opens = minutes(fx.master, ITEM.emerald, ALL).every.filter((r) => r.time < before).map((r) => r.open).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const k = opens.length;
    const median = k % 2 ? opens[(k - 1) / 2]! : (opens[k / 2 - 1]! + opens[k / 2]!) / 2n;
    assert.equal(api.market(ITEM.emerald, s).usual, median, `${k} minutes`);
  }
  // Nothing in the range: no low, high or volume. The usual price is the one at the range's end, which needs no minute inside it (AT-45).
  assert.deepEqual(api.market(ITEM.wheat, { from: T0 + 200 * MIN, to: null, server: null }), { usual: api.market(ITEM.wheat, ALL).usual, low: null, high: null, volume: 0, traders: 0 });
  // A market without candles: the usual price is the median order price, here of Mikko_82's two wheat sales.
  const save = path.join(fx.root, 'no-wheat-candles');
  fs.cpSync(fx.master, save, { recursive: true });
  const db = new DatabaseSync(path.join(save, 'data/StockMarket/Database/stockdata.db'));
  db.prepare('DELETE FROM MarketPrice WHERE marketid = ?').run(ITEM.wheat);
  db.close();
  open(save);
  const [a, b] = api.orders({ item: ITEM.wheat }, ALL).map((o) => o.price);
  assert.deepEqual(api.market(ITEM.wheat, ALL), { usual: (a! + b!) / 2n, low: null, high: null, volume: 0, traders: 1 });
});

test('traders: the same profits as on the Players screen, largest first', () => {
  open(fx.master);
  assert.deepEqual(api.traders(ITEM.diamond, ALL), [{ uuid: uuid('Tavrik'), name: 'Tavrik', bought: 44_037_000n, sold: 588_120_000n, profit: 544_083_000n }]);
  for (const item of Object.values(ITEM))
    for (const t of api.traders(item, ALL)) {
      const m = api.player(t.uuid, ALL)!.markets.find((x) => x.item === item)!;
      assert.deepEqual([t.bought, t.sold, t.profit], [m.bought, m.sold, m.profit], `${t.name} on item ${item}`);
    }
  assert.deepEqual(api.traders(ITEM.emerald, ALL).map((t) => [t.name, t.profit]), [['Quenby', 15_227_000n]]);
  assert.deepEqual(api.traders(ITEM.diamond, { ...ALL, server: 'mining-1' }), []);
});

test('finish time: read from SM-317 saves, null on older ones', () => {
  open(fx.master);
  const iron = api.orders({ item: ITEM.iron }, ALL)[0]!;
  assert.equal(iron.finishMs, iron.time + 7 * MIN); // a limit order that waited 7 minutes in the book
  open(fx.legacy);
  assert.deepEqual(api.orders({}, ALL).map((o) => o.finishMs).filter((v) => v !== null), []);
  assert.equal(api.markets(ALL)[0]!.item, ITEM.diamond); // the old save's candles give the same market list
});

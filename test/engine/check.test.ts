import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { allGaps, rate } from '../../src/engine/query/check.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type RuleSettings, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, CHECK, ITEM, PLAYERS, T0, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
const at = (minute: number) => T0 + minute * MIN;
/** Every difference counts as a gap: the cases below keep their figures whatever the default threshold is. */
const EVERY: RuleSettings = { ...DEFAULT_RULES, balance: { on: true, money: 0n, items: 0n } };
const money = (account: number, scope = ALL, settings = EVERY) => api.check(account, scope, settings).find((c) => c.item === ITEM.money)!;

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-check-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('rating: below 2.2.0 low, from the first BS-254 row high, else medium', () => {
  assert.equal(rate('2.1.2', 5, 10), 'low');
  assert.equal(rate(null, null, 10), 'low');
  assert.equal(rate('2.2.0', null, 10), 'medium');
  assert.equal(rate('2.2.0', 11, 10), 'medium');
  assert.equal(rate('2.2.0', 10, 10), 'high');
  assert.equal(rate('2.10.0-dev', 1, 10), 'high');
});

test('current save: the ordinary accounts explain every change, only the cases show gaps', () => {
  open(fx.master);
  assert.deepEqual(allGaps().map((g) => [g.account, g.item, g.from, g.to, g.difference, g.labels, g.rating]), [
    [CHECK.gain, ITEM.money, at(10), at(11), 500_000n, [], 'medium'],
    [CHECK.pair, ITEM.money, at(22), at(40), 100_000n, [], 'medium'],
    [CHECK.pair, ITEM.money, at(40), at(60), -100_000n, [], 'medium'],
    [CHECK.set, ITEM.money, at(30), at(31), -1_000_000n, ['ADMIN_SET'], 'medium'],
    [CHECK.raw, ITEM.money, at(102), at(110), 100_000n, [], 'high'],
  ]);
  // An item first bought in the range has one snapshot only: nothing to compare.
  assert.deepEqual(api.check(PLAYERS.Ombrelune.account, ALL, EVERY).map((c) => [c.item, c.verdict]), [[ITEM.money, 'explained'], [ITEM.gold, 'unchecked']]);
  for (const p of Object.values(PLAYERS)) assert.ok(api.check(p.account, ALL, EVERY).every((c) => c.unexplained === 0n), `account ${p.account}`);
});

test('an unexplained gain is flagged', () => {
  open(fx.master);
  assert.deepEqual(money(CHECK.gain), {
    item: ITEM.money, start: 1_000_000n, trades: 0n, paidIn: 0n, paidOut: 0n, shouldBe: 1_000_000n, is: 1_500_000n, unexplained: 500_000n,
    gaps: [{ from: at(10), to: at(11), difference: 500_000n, labels: [], rating: 'medium' }], verdict: 'unexplained',
  });
});

test('a pair that cancels within 15 minutes is joined to nothing, one 38 minutes apart is not', () => {
  open(fx.master);
  assert.deepEqual(money(CHECK.pair, { from: null, to: at(30), server: null }).verdict, 'explained');
  assert.deepEqual(money(CHECK.pair).gaps.map((g) => g.difference), [100_000n, -100_000n]);
});

test('the verdict counts a gap only above the "Balance not explained" threshold', () => {
  open(fx.master);
  // The pair's two gaps are exactly $1'000, the default threshold: not above it. The total difference stays.
  const pair = money(CHECK.pair, ALL, DEFAULT_RULES);
  assert.deepEqual([pair.gaps, pair.verdict, pair.unexplained], [[], 'explained', 0n]);
  assert.equal(money(CHECK.gain, ALL, DEFAULT_RULES).verdict, 'unexplained');
  const high: RuleSettings = { ...DEFAULT_RULES, balance: { on: true, money: 500_000n, items: 100_000n } };
  assert.deepEqual([money(CHECK.gain, ALL, high).verdict, money(CHECK.gain, ALL, high).unexplained], ['explained', 500_000n]);
});

test('an admin set without a readable note labels its gap', () => {
  open(fx.master);
  const c = money(CHECK.set);
  assert.deepEqual([c.paidOut, c.unexplained, c.verdict, c.gaps[0]!.labels], [0n, -1_000_000n, 'unknown-rows', ['ADMIN_SET']]);
});

test('a share stamp moves no balance', () => {
  open(fx.master);
  assert.deepEqual(api.check(CHECK.stamp, ALL, EVERY).map((c) => [c.item, c.paidIn, c.verdict]), [[ITEM.money, 0n, 'explained']]);
});

test('BS-254 with an older StockMarket: a fill logged as trade and raw change counts once', () => {
  open(fx.master);
  const [m, d] = api.check(CHECK.raw, { from: null, to: at(102), server: null }, EVERY);
  assert.deepEqual([m!.item, m!.trades, m!.paidIn, m!.verdict], [ITEM.money, 200_000n, 0n, 'explained']);
  assert.deepEqual([d!.item, d!.trades, d!.paidOut, d!.verdict], [ITEM.diamond, -4_000n, 0n, 'explained']);
});

test('a deleted account with snapshots only is checked', () => {
  open(fx.master);
  assert.equal(api.account(CHECK.gone, ALL), null);
  assert.deepEqual(api.check(CHECK.gone, ALL, EVERY).map((c) => [c.item, c.start, c.is, c.verdict]), [[ITEM.money, 250_000n, 250_000n, 'explained']]);
  assert.deepEqual(api.check(999, ALL, EVERY), []);
});

test('legacy save: orders stand in for trades, the unlogged admin actions are the only gaps, rated low', () => {
  open(fx.legacy);
  const tavrik = api.check(PLAYERS.Tavrik.account, ALL, EVERY);
  assert.deepEqual(tavrik.map((c) => [c.item, c.verdict]), [[ITEM.money, 'explained'], [ITEM.diamond, 'explained']]);
  assert.ok(tavrik[0]!.trades > 0n);
  assert.deepEqual(allGaps().map((g) => [g.account, g.from, g.to, g.difference, g.rating]), [
    [PLAYERS.Quenby.account, at(61), at(121), -20_000_000n, 'low'],
    [PLAYERS.AdmiralNoor.account, at(-24 * 60), at(126), -2_500_000n, 'low'],
  ]);
});

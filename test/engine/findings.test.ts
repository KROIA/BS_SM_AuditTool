import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { group, level, orderIds, roundTrips } from '../../src/engine/query/findings.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Finding, type OrderRow, type RuleId, type RuleSettings, type Scope } from '../../src/shared/api.ts';
import { describe } from '../../src/shared/finding.ts';
import { ALERT, AUDIT_OFFSET, buildFixtures, CHECK, COMPANY, ITEM, LAST_SAVE, LOST_FLAG, PLAYERS, STRAY, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
const at = (minute: number) => T0 + minute * MIN;
const uuid = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);
const of = (rule: RuleId, settings: RuleSettings = DEFAULT_RULES, scope = ALL) => api.findings(scope, settings).findings.filter((f) => f.rule === rule);
const set = <K extends keyof RuleSettings>(rule: K, s: Partial<RuleSettings[K]>): RuleSettings => ({ ...DEFAULT_RULES, [rule]: { ...DEFAULT_RULES[rule], ...s } });
const who = (f: Finding) => f.players.map((p) => p.name);
const LOG_FLAG = `bank-flag:log@${LOST_FLAG.ts + AUDIT_OFFSET}:${LOST_FLAG.account}:${LOST_FLAG.type}`;

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-findings-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('level: one higher at ten times the threshold, none without a threshold', () => {
  assert.equal(level('medium', 49, 5), 'medium');
  assert.equal(level('medium', 50, 5), 'high');
  assert.equal(level('high', 1_000_000n, 100_000n), 'critical');
  assert.equal(level('critical', 99, 1), 'critical');
  assert.equal(level('low', 1_000n, null), 'low');
});

test('group: hits on one subject less than 15 minutes apart are one, other subjects stay apart', () => {
  const hit = (subject: string, start: number, end = start) => ({ subject, start, end, value: 1, orders: [], facts: {} });
  const g = group([hit('a', at(0), at(5)), hit('b', at(1)), hit('a', at(19)), hit('a', at(40))]);
  assert.deepEqual(g.map((x) => x.map((h) => [h.subject, (h.start - T0) / MIN])), [[['a', 0], ['a', 19]], [['a', 40]], [['b', 1]]]);
});

test('round trip: cheap buy and dear sale within the window, another player in between breaks it', () => {
  const o = (id: number, player: string, second: number, amount: bigint, price: bigint): OrderRow =>
    ({ id, orderId: id, item: ITEM.diamond, account: 1, player, type: 'market', amount, price, money: (amount * price) / 100n, time: T0 + second * 1000, finishMs: null, server: null, limitPrice: null, wanted: null, status: null });
  const [buy, sell] = [o(1, 'p', 0, 100n, 1_000n), o(2, 'p', 10, -100n, 3_000n)];
  assert.deepEqual(roundTrips([buy, sell], 2, 30).map((h) => [h.value, h.orders.map((x) => x.id)]), [[3, [1, 2]]]);
  assert.equal(roundTrips([buy, sell], 3, 30).length, 0); // not above the factor
  assert.equal(roundTrips([buy, sell], 2, 5).length, 0); // outside the window
  assert.equal(roundTrips([buy, o(3, 'q', 5, 1n, 2_000n), sell], 2, 30).length, 0); // someone else traded in between
});

test('round trip: none at the defaults, Tavrik and Quenby with a 20-minute window', () => {
  open(fx.master);
  assert.deepEqual(of('round-trip'), []);
  const wide = of('round-trip', set('round-trip', { seconds: 1200 }));
  assert.deepEqual(wide.map((f) => [who(f), f.level, f.facts.rounds]), [[['Tavrik'], 'high', 30], [['Quenby'], 'high', 10]]);
});

test('order rate: the bursts of Tavrik and Quenby, nobody else', () => {
  open(fx.master);
  const f = of('order-rate');
  assert.deepEqual(f.map((x) => [who(x), x.start, x.measured.value, x.facts.orders, x.records.orders.length]), [
    [['Tavrik'], at(21), 30, 30, 30],
    [['Tavrik'], at(40), 30, 30, 30],
    [['Quenby'], at(46), 10, 20, 20], // two bursts less than 15 minutes apart: one finding with every order
  ]);
  assert.ok(f.every((x) => x.level === 'medium' && x.measured.threshold === 5 && x.facts.medianGapMs === 20));
  assert.equal(of('order-rate', set('order-rate', { orders: 30 })).length, 0);
});

test('profit per hour: Tavrik above $1M, Quenby below', () => {
  open(fx.master);
  const [f, ...rest] = of('hour-profit');
  assert.equal(rest.length, 0);
  assert.deepEqual([who(f!), f!.level, f!.measured, f!.start, f!.end], [['Tavrik'], 'high', { value: 544_083_000n, threshold: 100_000_000n, unit: 'money' }, T0, T0 + 60 * MIN - 1]);
  // At $50k Quenby's hour counts too, and Tavrik's is more than ten times it.
  assert.deepEqual(of('hour-profit', set('hour-profit', { money: 5_000_000n })).map((x) => [who(x), x.level]), [[['Tavrik'], 'critical'], [['Quenby'], 'high']]);
});

test('price far from usual: Tavrik\'s diamonds and Quenby\'s emeralds, per market', () => {
  open(fx.master);
  const f = of('far-price');
  assert.deepEqual(f.map((x) => [x.markets, who(x), x.facts.usual, x.facts.orders]), [[[ITEM.diamond], ['Tavrik'], 5_270n, 30], [[ITEM.emerald], ['Quenby'], 3_009n, 10]]);
  assert.ok((f[0]!.measured.value as number) > 37 && (f[1]!.measured.value as number) < 12);
  assert.deepEqual(of('far-price', set('far-price', { times: 12 })).map((x) => x.markets), [[ITEM.diamond]]);
});

test('price spike: the diamond candle of minute 40 only', () => {
  open(fx.master);
  const [f, ...rest] = of('price-spike');
  assert.equal(rest.length, 0);
  assert.deepEqual([f!.markets, f!.records.candles, f!.records.orders, who(f!), f!.servers], [[ITEM.diamond], [{ market: ITEM.diamond, time: at(40) }], [], ['Tavrik'], []]);
  assert.equal(of('price-spike', set('price-spike', { times: 6 })).length, 0);
});

test('balance not explained: gaps above the threshold, level from the rating and the bump', () => {
  open(fx.master);
  assert.deepEqual(of('balance').map((f) => [f.accounts, f.level, f.measured.value, f.facts.rating, f.facts.labels]), [
    [[CHECK.set], 'high', 1_000_000n, 'medium', ['ADMIN_SET']], // ten times the threshold: one higher
    [[CHECK.gain], 'medium', 500_000n, 'medium', []],
  ]); // the pair's $1'000 gaps and the raw case's are not above $1'000
  assert.equal(of('balance', set('balance', { money: 99_999n })).length, 5);
});

test('order and ledger disagree: the order whose rows add up to more than its volume', () => {
  open(fx.master);
  const [f, ...rest] = of('order-ledger');
  assert.equal(rest.length, 0);
  assert.deepEqual([who(f!), f!.records.orders, f!.facts.volume, f!.facts.logged, f!.level, f!.measured.threshold, f!.records.ledger.length, f!.servers],
    [['Brindle'], [STRAY.order], 6_400n, 9_600n, 'medium', null, 2, ['mining-1']]);
});

test('bank flags: as raised, severity to level, acknowledged carried, thresholds from the save\'s settings', () => {
  open(fx.master);
  const r = api.findings(ALL, DEFAULT_RULES);
  assert.deepEqual(r.findings.filter((f) => f.rule === 'bank-flag').map((f) => [f.id, f.level, f.accounts, f.acknowledged, f.basis, f.source, f.measured.threshold, f.measured.unit]), [
    ['bank-flag:3', 'critical', [COMPANY.account], true, 'as raised', 'bank mod', null, 'shares'],
    [LOG_FLAG, 'critical', [LOST_FLAG.account], null, 'as raised', 'bank mod', 1_000_000_000n, 'money'], // only in the audit log
    ['bank-flag:2', 'high', [PLAYERS.Ombrelune.account], false, 'as raised', 'bank mod', 200_000_000n, 'money'],
    ['bank-flag:1', 'medium', [PLAYERS.Tavrik.account], false, 'as raised', 'bank mod', 100_000_000n, 'money'],
  ]);
  // settings.json: one key changed, an invalid value left at its default, keys outside "Audit" ignored.
  assert.deepEqual([r.bankSettings.LAUNDERING_MIN_AMOUNT, r.bankSettings.WEALTH_JUMP_PERCENT, r.bankSettings.STARTING_BALANCE], [2_000_000, 100, undefined]);
});

test('ledger rows after the last bank save: one hint with the newer rows only', () => {
  open(fx.master);
  const [f, ...rest] = of('last-save');
  assert.equal(rest.length, 0);
  assert.deepEqual([f!.id, f!.level, f!.basis, f!.facts.lastSave, f!.measured.value, f!.records.ledger.length, who(f!)], ['last-save:after-save', 'low', 'hint', LAST_SAVE, 1, 1, ['Mikko_82']]);
  assert.ok(f!.start > LAST_SAVE);
});

test('old save: the rules without data say why', () => {
  open(fx.legacy);
  const r = api.findings(ALL, DEFAULT_RULES);
  const why = Object.fromEntries(r.rules.map((s) => [s.rule, s.notApplicable === null ? s.found : 'n/a']));
  // banknotes runs (AT-35): Tavrik's notes in his player file match the corrected count.
  assert.deepEqual(why, { 'round-trip': 0, 'order-rate': 3, 'hour-profit': 1, 'far-price': 2, 'price-spike': 1, 'balance': 5,
    'order-ledger': 'n/a', 'bank-flag': 'n/a', 'last-save': 'n/a', 'market-alert': 'n/a', 'transfer': 'n/a', 'banknotes': 0 });
  assert.ok(r.rules.every((s) => s.notApplicable === null || s.notApplicable.length > 10));
  assert.equal(r.bankSettings.LAUNDERING_MIN_AMOUNT, 1_000_000); // no settings file: the mod's defaults
});

test('a rule turned off reports no count and no findings', () => {
  open(fx.master);
  const r = api.findings(ALL, set('order-rate', { on: false }));
  assert.deepEqual(r.rules.find((s) => s.rule === 'order-rate'), { rule: 'order-rate', on: false, found: null, notApplicable: null });
  assert.ok(!r.findings.some((f) => f.rule === 'order-rate'));
});

test('the same settings give the kept result, a changed threshold re-runs only its rule', () => {
  open(fx.master);
  const first = api.findings(ALL, DEFAULT_RULES).findings;
  const again = api.findings(ALL, { ...DEFAULT_RULES }).findings;
  assert.deepEqual(again.map((f) => f.id), first.map((f) => f.id));
  assert.ok(again.every((f, i) => f === first[i])); // the very same objects
  const changed = api.findings(ALL, set('far-price', { times: 12 })).findings;
  const same = (f: Finding) => first.find((x) => x.id === f.id) === f;
  assert.ok(changed.filter((f) => f.rule !== 'far-price').every(same));
  assert.ok(!changed.some((f) => f.rule === 'far-price' && same(f)));
});

test('scope: the time range keeps what overlaps it, a server keeps its orders\' findings and those without a server', () => {
  open(fx.master);
  const ids = (scope: Scope) => api.findings(scope, DEFAULT_RULES).findings.map((f) => f.id);
  const all = ids(ALL);
  const range = api.findings({ from: at(39), to: at(41), server: null }, DEFAULT_RULES).findings;
  assert.ok(range.length > 0 && range.length < all.length && range.every((f) => f.end >= at(39) && f.start <= at(41)));
  const mining = api.findings({ ...ALL, server: 'mining-1' }, DEFAULT_RULES).findings;
  assert.deepEqual(mining.filter((f) => f.servers.length).map((f) => [f.rule, who(f)]), [['order-ledger', ['Brindle']]]);
  assert.equal(mining.length, all.length - api.findings(ALL, DEFAULT_RULES).findings.filter((f) => f.servers.length && !f.servers.includes('mining-1')).length);
});

// The fixed run (PLAN.md section 5): every finding on the fixture network. A change to a rule shows up here as a diff.
test('fixed run: every finding on the current and the old save', () => {
  const run = () => api.findings(ALL, DEFAULT_RULES).findings.map((f) => `${f.level} ${f.id}`);
  const tavrik = uuid('Tavrik'), quenby = uuid('Quenby'), brindle = uuid('Brindle');
  open(fx.master);
  assert.deepEqual(run(), [
    'critical bank-flag:3',
    `critical ${LOG_FLAG}`,
    `high hour-profit:${tavrik}@${T0}`,
    `high balance:${CHECK.set}:${ITEM.money}@${at(30)}`,
    'high market-alert:2', // SM-316: Tavrik's profit alert, more than ten times the server's threshold
    'high bank-flag:2',
    'medium banknotes:count', // AT-35: $174'722 of notes the count expects are in no player file; spans the whole log, so it sorts first
    `medium order-ledger:${brindle}@${T0 + 301_200}`,
    `medium balance:${CHECK.gain}:${ITEM.money}@${at(10)}`,
    `medium order-rate:${tavrik}@${at(21)}`,
    'medium market-alert:1', // SM-316: the pump on Tavrik's diamond buys
    `medium far-price:market ${ITEM.diamond}@${at(40)}`,
    `medium order-rate:${tavrik}@${at(40)}`,
    `medium price-spike:market ${ITEM.diamond}@${at(40)}`,
    'medium bank-flag:1',
    `medium order-rate:${quenby}@${at(46)}`,
    `medium far-price:market ${ITEM.emerald}@${at(60)}`,
    'medium market-alert:3', // SM-316: Quenby's emerald cycle
    'medium market-alert:4', // SM-316: the pump in a minute without a price
    'low last-save:after-save',
  ]);
  open(fx.legacy);
  assert.deepEqual(run(), [
    `high hour-profit:${tavrik}@${T0}`,
    `medium balance:${PLAYERS.AdmiralNoor.account}:${ITEM.money}@${at(-24 * 60)}`,
    `medium balance:${PLAYERS.Mikko_82.account}:${ITEM.money}@${at(13)}`, // an admin raised the balance, unlogged (2.1.2)
    `medium order-rate:${tavrik}@${at(21)}`,
    `medium far-price:market ${ITEM.diamond}@${at(40)}`,
    `medium order-rate:${tavrik}@${at(40)}`,
    `medium price-spike:market ${ITEM.diamond}@${at(40)}`,
    `medium order-rate:${quenby}@${at(46)}`,
    `medium balance:${PLAYERS.Tavrik.account}:${ITEM.money}@${at(51)}`, // notes put back without a row (2.1.2)
    `medium far-price:market ${ITEM.emerald}@${at(60)}`,
    `medium balance:${PLAYERS.Quenby.account}:${ITEM.money}@${at(61)}`,
    `medium balance:${PLAYERS.Brindle.account}:${ITEM.money}@${at(63)}`, // notes paid in through the ATM converter, unlogged (2.1.2)
  ]);
});

test('market alerts (SM-316): one finding per row, level from the threshold, orders and their ledger rows as records', () => {
  open(fx.master);
  const list = of('market-alert');
  assert.deepEqual(list.map((f) => [f.id, f.level, f.basis, f.source, f.start, f.end, who(f), f.markets, f.accounts, f.servers, f.records.orders.length, f.records.ledger.length]), [
    ['market-alert:2', 'high', 'as raised', 'market mod', ALERT.profit, ALERT.profit, ['Tavrik'], [], [], [], 0, 0], // 555'000 is more than ten times 50'000
    ['market-alert:1', 'medium', 'as raised', 'market mod', ALERT.pump, ALERT.pump, ['Tavrik'], [ITEM.diamond], [PLAYERS.Tavrik.account], ['survival-main'], 2, 2],
    ['market-alert:3', 'medium', 'as raised', 'market mod', ALERT.cycle, ALERT.cycle, ['Quenby'], [ITEM.emerald], [PLAYERS.Quenby.account], ['survival-main'], 1, 1],
    ['market-alert:4', 'medium', 'as raised', 'market mod', ALERT.noPrice, ALERT.noPrice, ['Ombrelune'], [ITEM.coal], [PLAYERS.Ombrelune.account], [], 0, 0], // old coal id 40 merged; '12,abc' read as no orders
  ]);
  const [profit, pump, cycle, noPrice] = list;
  // Money alerts: the raw amount against the server's threshold in whole money units, times 100.
  assert.deepEqual([profit!.measured, cycle!.measured], [{ value: 555_000_000n, threshold: 5_000_000n, unit: 'money' }, { value: 15_000_000n, threshold: 10_000_000n, unit: 'money' }]);
  // A pump: the rise against the open of that minute's candle. The builder made it a quarter of the open.
  assert.equal(pump!.measured.unit, 'percent');
  assert.ok(Math.abs((pump!.measured.value as number) - 25) < 0.01 && pump!.measured.threshold === 20);
  assert.deepEqual([noPrice!.measured, noPrice!.facts.open, noPrice!.facts.percent], [{ value: 30n, threshold: null, unit: 'money' }, null, null]);
  assert.ok(pump!.records.ledger.every((id) => typeof id === 'number'));
  // The time range and the server filter treat them like any finding.
  assert.deepEqual(of('market-alert', DEFAULT_RULES, { ...ALL, from: at(100) }).map((f) => f.id), ['market-alert:4']);
  assert.deepEqual(of('market-alert', DEFAULT_RULES, { ...ALL, server: 'mining-1' }).map((f) => f.id), ['market-alert:2', 'market-alert:4']); // no orders, no server
  assert.deepEqual(of('market-alert', set('market-alert', { on: false })), []);
});

test('market alerts: the sentences put every number through fmt', () => {
  open(fx.master);
  const w = { itemName: (id: number) => (id === ITEM.diamond ? 'Diamond' : id === ITEM.emerald ? 'Emerald' : 'Coal'), isMoney: () => false };
  const words = of('market-alert').map((f) => describe(f, w));
  assert.deepEqual(words.map((x) => x.measured), [
    "$5'550'000.00, the server's limit is $50'000.00", "a rise of 24.99%, the server's limit is 20%",
    "$150'000.00, the server's limit is $100'000.00", 'a rise of $0.30 per item; without a price for that minute the percent is unknown',
  ]);
  assert.ok(words.every((x) => x.facts.some(([k]) => k === 'Server log line')));
});

test('order ids of an alert: a bounded comma list, anything else is read as none', () => {
  assert.deepEqual(orderIds('3, 5,3'), [3, 5]);
  assert.deepEqual([orderIds(null), orderIds(''), orderIds('12,abc'), orderIds('-1'), orderIds('1'.repeat(16))], [[], [], [], [], []]);
  assert.equal(orderIds(Array.from({ length: 1000 }, (_, i) => i).join(',')).length, 1000);
  assert.deepEqual(orderIds(Array.from({ length: 1001 }, (_, i) => i).join(',')), []);
});

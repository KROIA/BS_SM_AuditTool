import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, init, mainData } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, COMPANY, ITEM, ORDER_END, PLACES, PLAYERS, SHARED, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const uuid = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);
let fx: Fixtures;
let n = 0;
/** A fresh workspace with one save loaded. */
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
/** The open price of a market's candle in a minute of the scenario: the price every order of that minute was filled at. */
const priceAt = (item: number, minute: number) =>
  BigInt((mainData()!.prepare('SELECT open FROM candle WHERE market = ? AND time = ?').get(item, T0 + minute * MIN) as { open: number }).open);

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-players-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('with nothing loaded every question answers empty', () => {
  init(path.join(fx.root, 'empty-workspace'));
  assert.deepEqual([api.items(), api.players(ALL), api.orders({}, ALL), api.ledger({ accounts: [11] }, ALL)], [[], [], [], []]);
  assert.equal(api.player(uuid('Tavrik'), ALL), null);
});

test('players: sorted by profit, with order counts and first and last activity', () => {
  open(fx.master);
  const list = api.players(ALL);
  assert.deepEqual(list.map((p) => [p.name, p.orders]), [['Tavrik', 60], ['Quenby', 20], ['AdmiralNoor', 0], ['Brindle', 3], ['Mikko_82', 2], ['Ombrelune', 1]]);
  // Tavrik buys 30 x 100 diamonds at minute 21 and sells them at minute 40: profit 3'000 x the price difference.
  const diamond = 3000n * (priceAt(ITEM.diamond, 40) - priceAt(ITEM.diamond, 21));
  const emerald = 500n * (priceAt(ITEM.emerald, 60) - priceAt(ITEM.emerald, 46));
  assert.deepEqual(list.map((p) => p.profit), [diamond, emerald, 0n, 0n, 0n, 0n]);
  assert.deepEqual([diamond, emerald], [544_083_000n, 15_227_000n]);
  const tavrik = list[0]!;
  assert.equal(tavrik.uuid, uuid('Tavrik'));
  assert.equal(tavrik.firstMs, T0 - 24 * 60 * MIN); // the starting balance row names Tavrik as the actor
  assert.equal(tavrik.lastMs, T0 + 55 * MIN); // the transfer to Ombrelune
  assert.equal(list.find((p) => p.name === 'Mikko_82')!.lastMs, T0 + 130 * MIN + 5300); // the last order of the scenario
});

test('the time range: purchases before it set the cost, sales inside it count', () => {
  open(fx.master);
  const sales = api.player(uuid('Tavrik'), { from: T0 + 30 * MIN, to: null, server: null })!;
  assert.equal(sales.orders, 30);
  assert.deepEqual(sales.markets, [{ item: ITEM.diamond, orders: 30, bought: 0n, sold: 588_120_000n, profit: 544_083_000n, soldWithoutPurchase: 0n }]);
  const buys = api.player(uuid('Tavrik'), { from: null, to: T0 + 30 * MIN, server: null })!;
  assert.deepEqual(buys.markets, [{ item: ITEM.diamond, orders: 30, bought: 44_037_000n, sold: 0n, profit: 0n, soldWithoutPurchase: 0n }]);
  assert.equal(buys.lastMs, T0 + 21 * MIN + 29 * 20);
  // A range with nothing of the player in it
  const quiet = api.player(uuid('Tavrik'), { from: T0 + 140 * MIN, to: null, server: null })!;
  assert.deepEqual([quiet.orders, quiet.profit, quiet.markets, quiet.firstMs, quiet.lastMs], [0, 0n, [], null, null]);
  assert.deepEqual(api.orders({ player: uuid('Tavrik') }, { from: T0 + 140 * MIN, to: null, server: null }), []);
  // The buys among the orders counted, and only the newest orders when the screen asks for a few (AT-52).
  assert.deepEqual([sales.buys, buys.buys, quiet.buys], [0, 30, 0]);
  const every = api.orders({ player: uuid('Tavrik') }, ALL);
  assert.deepEqual(api.orders({ player: uuid('Tavrik'), limit: 10 }, ALL), every.slice(0, 10));
  assert.equal(every.length, 60);
});

test('money for items never bought on the market is sold without a purchase, not profit', () => {
  open(fx.master);
  const mikko = api.player(uuid('Mikko_82'), ALL)!;
  assert.deepEqual(mikko.markets, [{ item: ITEM.wheat, orders: 2, bought: 0n, sold: 11_584n, profit: 0n, soldWithoutPurchase: 11_584n }]);
  const brindle = api.player(uuid('Brindle'), ALL)!;
  assert.deepEqual(brindle.markets.map((m) => [m.item, m.bought, m.sold, m.profit, m.soldWithoutPurchase]),
    [[ITEM.coal, 11_584n, 0n, 0n, 0n], [ITEM.iron, 0n, 6_432n, 0n, 6_432n]]);
});

test('the server filter: orders by where they were placed, through OrderOrigin', () => {
  open(fx.master);
  const brindle = api.orders({ player: uuid('Brindle') }, ALL);
  assert.deepEqual(brindle.map((o) => o.server), ['mining-1', 'mining-1', 'mining-1']);
  assert.ok(api.orders({ player: uuid('Tavrik') }, ALL).every((o) => o.server === 'survival-main')); // an empty origin name is the master
  const mining = api.players({ ...ALL, server: 'mining-1' });
  assert.deepEqual(mining.filter((p) => p.orders).map((p) => [p.name, p.orders]), [['Brindle', 3]]);
  assert.equal(api.orders({}, { ...ALL, server: 'nether-hub' }).length, 0);
  assert.equal(api.orders({}, { ...ALL, server: 'survival-main' }).length, 83);
});

test('orders: newest first, money is volume x average price / 100 cut off, filters by player and item', () => {
  open(fx.master);
  const all = api.orders({}, ALL);
  assert.equal(all.length, 86);
  assert.ok(all.every((o, i) => i === 0 || all[i - 1]!.time >= o.time));
  assert.ok(all.every((o) => o.money === (o.amount * o.price) / 100n && o.orderId === o.id));
  const iron = api.orders({ item: ITEM.iron }, ALL);
  assert.deepEqual(iron.map((o) => [o.player, o.type, o.amount, o.price, o.money, o.time]),
    [[uuid('Brindle'), 'limit', -1600n, priceAt(ITEM.iron, 90), -6_432n, T0 + 90 * MIN + 9000]]);
  assert.equal(api.orders({ player: uuid('Quenby'), item: ITEM.emerald }, { from: T0 + 50 * MIN, to: null, server: null }).length, 10);
});

test('one player: accounts, money now, and money over time from the snapshots', () => {
  open(fx.master);
  const tavrik = api.player(uuid('Tavrik'), ALL)!;
  assert.deepEqual(tavrik.accounts, [
    { number: PLAYERS.Tavrik.account, name: 'Tavrik', company: null, owner: true, permissions: null },
    { number: SHARED.account, name: SHARED.name, company: null, owner: false, permissions: 7 },
  ]);
  const own = fx.balances.master.get(`${PLAYERS.Tavrik.account}:${ITEM.money}`)!;
  assert.equal(tavrik.moneyNow, own); // the shared account is not Tavrik's own
  assert.equal(own, 94_083_000n);
  // One point per minute in which the account changed: start, buys, sells, two withdrawals, transfer.
  assert.deepEqual(tavrik.money, [
    [T0 - 24 * 60 * MIN, 50_000_000n], [T0 + 22 * MIN, 5_963_000n], [T0 + 41 * MIN, 594_083_000n],
    [T0 + 51 * MIN, 394_083_000n], [T0 + 52 * MIN, 194_083_000n], [T0 + 56 * MIN, 94_083_000n],
  ]);
  // Inside a range the series starts with what the account held at its start.
  assert.deepEqual(api.player(uuid('Tavrik'), { from: T0 + 45 * MIN, to: T0 + 51 * MIN, server: null })!.money,
    [[T0 + 45 * MIN, 594_083_000n], [T0 + 51 * MIN, 394_083_000n]]);
  const noor = api.player(uuid('AdmiralNoor'), ALL)!;
  assert.deepEqual(noor.accounts.map((a) => [a.number, a.owner, a.company]), [[10, true, null], [33, false, null], [COMPANY.account, false, COMPANY.name]]);
  assert.equal(noor.moneyNow, 7_500_000n);
  assert.equal(api.player('00000000-0000-4000-8000-000000000000', ALL), null);
});

test('ledger rows: newest first, and their changes add up to every final balance', () => {
  open(fx.master);
  const accounts = [...new Set([...fx.balances.master.keys()].map((k) => Number(k.split(':')[0])))];
  const rows = api.ledger({ accounts }, ALL);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1]!.time >= r.time));
  assert.ok(rows.every((r) => r.change !== null));
  // Goods and money side of each row, summed per account and item, give the balances the bank ends with.
  const sum = new Map<string, bigint>();
  const add = (account: number, item: number, v: bigint) => sum.set(`${account}:${item}`, (sum.get(`${account}:${item}`) ?? 0n) + v);
  for (const r of rows) {
    add(r.account, r.item, r.change!);
    if (r.money) add(r.account, r.money.item, r.money.change);
  }
  assert.deepEqual(sum, fx.balances.master);

  const byKind = (kind: string) => api.ledger({ accounts }, ALL).find((r) => r.kind === kind)!;
  const buy = byKind('TRADE_BUY'), sell = byKind('TRADE_SELL');
  assert.deepEqual([buy.change, buy.money, buy.balanceAfter], [buy.amount, { item: ITEM.money, change: -((buy.amount * priceAt(buy.item, Math.floor((buy.time - T0) / MIN))) / 100n) }, null]);
  assert.ok(sell.change! < 0n && sell.money!.change > 0n);
  const set = byKind('ADMIN_SET');
  assert.deepEqual([set.amount, set.change, set.actorName, set.sourceKind], [2_500_000n, -2_500_000n, 'AdmiralNoor', 'ADMIN']);
  const remove = byKind('ADMIN_REMOVE');
  assert.deepEqual([remove.account, remove.change, remove.note], [PLAYERS.Quenby.account, -20_000_000n, 'exploit profit removed']);

  const tavrik = api.ledger({ accounts: [PLAYERS.Tavrik.account] }, { from: T0 + 50 * MIN, to: T0 + 55 * MIN, server: null });
  assert.deepEqual(tavrik.map((r) => [r.kind, r.change, r.otherAccount, r.balanceAfter]), [
    ['TRANSFER', -100_000_000n, PLAYERS.Ombrelune.account, 94_083_000n],
    ['WITHDRAW', -200_000_000n, null, 194_083_000n],
    ['WITHDRAW', -200_000_000n, null, 394_083_000n],
  ]);
  assert.deepEqual(api.ledger({ accounts: [] }, ALL), []);
});

test('items: names as stored and which one is money', () => {
  open(fx.master);
  const items = api.items();
  assert.deepEqual(items.filter((i) => i.money).map((i) => i.id), [ITEM.money]);
  assert.equal(items.find((i) => i.id === ITEM.iron)!.name, 'minecraft:iron_ingot');
});

test('an old 2.1.2 save: the same profits, no server for any order, and a log without trade rows', () => {
  open(fx.legacy);
  const list = api.players(ALL);
  assert.deepEqual(list.slice(0, 2).map((p) => [p.name, p.orders, p.profit]), [['Tavrik', 60, 544_083_000n], ['Quenby', 20, 15_227_000n]]);
  const orders = api.orders({}, ALL);
  assert.ok(orders.every((o) => o.orderId === null && o.server === null));
  assert.ok(orders.every((o) => o.limitPrice === null && o.wanted === null && o.status === null)); // before SM-317
  assert.equal(api.orders({}, { ...ALL, server: 'old-world' }).length, 0); // nothing says where an order was placed
  const rows = api.ledger({ accounts: [PLAYERS.Tavrik.account] }, ALL);
  assert.ok(rows.every((r) => r.server === null && r.place === null)); // before BS-256 and BS-258
  assert.deepEqual(api.ledger({ accounts: [PLAYERS.Tavrik.account] }, { ...ALL, server: 'old-world' }), rows); // not known, so not filtered out
  assert.deepEqual(rows.map((r) => [r.kind, r.change, r.money, r.balanceAfter]), [
    ['WITHDRAW', -200_000_000n, null, null], ['WITHDRAW', -200_000_000n, null, null], // 2.1.2 logged no starting balance
  ]);
});

test('orders (SM-317): limit price, the volume asked for and how an order ended', () => {
  open(fx.master);
  const all = api.orders({}, ALL);
  const odd = all.filter((o) => o.wanted !== o.amount || o.status !== 'filled');
  assert.deepEqual(odd.map((o) => [o.player, o.type, o.amount, o.wanted, o.limitPrice, o.status]), [
    [uuid('Mikko_82'), 'market', ORDER_END.wheatWanted / 2n, ORDER_END.wheatWanted, 0n, 'cancelled by the server'],
    [uuid('Ombrelune'), 'limit', ORDER_END.goldWanted / 2n, ORDER_END.goldWanted, ORDER_END.goldLimit, 'cancelled by the player'],
  ]);
  assert.ok(all.every((o) => (o.type === 'limit') === (o.limitPrice! > 0n))); // 0 is a market order
});

test('ledger rows (BS-256, BS-258): the server a row was made for and where the player stood', () => {
  open(fx.master);
  const accounts = api.accounts(ALL, DEFAULT_RULES).map((a) => a.number);
  const rows = api.ledger({ accounts }, ALL);
  const count = (server: string) => rows.filter((r) => r.server === server).length;
  assert.deepEqual([count('survival-main'), count('mining-1'), count('nether-hub'), rows.length], [107, 11, 2, 120]); // no origin is the master (with the delete payout on account 18); mining-1's include the rejected code there
  assert.deepEqual(rows.filter((r) => r.place).map((r) => [r.kind, r.account, r.place]), [
    ['DEPOSIT', PLAYERS.Ombrelune.account, PLACES.deposit], ['WITHDRAW', PLAYERS.Tavrik.account, PLACES.withdraw],
  ]);
  // The filter keeps the rows of that server only; the master's name keeps those without an origin.
  const mining = api.ledger({ accounts }, { ...ALL, server: 'mining-1' });
  assert.ok(mining.length === 11 && mining.every((r) => r.server === 'mining-1'));
  assert.equal(api.ledger({ accounts }, { ...ALL, server: 'survival-main' }).length, 107);
  const tavrik = api.ledger({ accounts: [PLAYERS.Tavrik.account] }, { from: T0 + 50 * MIN, to: T0 + 55 * MIN, server: 'mining-1' });
  assert.deepEqual(tavrik.map((r) => [r.kind, r.time]), [['WITHDRAW', T0 + 51 * MIN + 500]]);
});

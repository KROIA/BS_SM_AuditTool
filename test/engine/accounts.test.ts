import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type RuleSettings, type Scope } from '../../src/shared/api.ts';
import { ALIAS, buildFixtures, CHECK, COMPANY, ITEM, PLAYERS, SHARED, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const uuid = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
const moneyOf = (balances: Map<string, bigint>, account: number) => balances.get(`${account}:${ITEM.money}`) ?? 0n;

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-accounts-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('with nothing loaded the account questions answer empty', () => {
  init(path.join(fx.root, 'empty-workspace'));
  assert.deepEqual([api.accounts(ALL, DEFAULT_RULES), api.balances(11, ITEM.money, ALL)], [[], []]);
  assert.equal(api.account(11, ALL), null);
});

test('accounts: most money first where the log explains everything, money from the bank files, log entries counted', () => {
  open(fx.master);
  const list = api.accounts(ALL, DEFAULT_RULES).filter((a) => !a.deleted);
  assert.deepEqual(list.map((a) => a.number), [COMPANY.account, 24, 11, 3, 27, 10, 7, SHARED.account, 31, 32, 33]);
  for (const a of list) assert.equal(a.money, moneyOf(fx.balances.master, a.number), `account ${a.number}`);
  assert.equal(list[0]!.money, 9_007_199_254_740_993n); // above 2^53: exact only as a bigint
  // Ombrelune, Brindle, Mikko_82 and AdmiralNoor carry the master's rows of the transfer cases (fixtures, TRANSFER_CASES).
  assert.deepEqual(list.map((a) => a.rows), [1, 6, 64, 7, 8, 3, 22, 1, 0, 0, 0]);
  assert.deepEqual(list.find((a) => a.number === 11), {
    number: 11, name: 'Tavrik', company: null, frozen: false, owner: uuid('Tavrik'), ownerName: 'Tavrik', money: 94_083_000n, rows: 64,
    deleted: false, unexplained: 0n, gaps: 0, rating: null,
  });
  assert.equal(list.find((a) => a.number === 31)!.frozen, true);
  // The time range counts log entries, the money stays the state of the copy.
  const window = api.accounts({ from: T0 + 50 * MIN, to: T0 + 55 * MIN, server: null }, DEFAULT_RULES);
  assert.deepEqual(window.filter((a) => a.rows).map((a) => [a.number, a.rows]), [[24, 1], [11, 3]]);
  assert.equal(window.find((a) => a.number === 11)!.money, 94_083_000n);
});

test('accounts: the money the log does not explain first; deleted accounts are listed and checked', () => {
  open(fx.master);
  const head = (settings: RuleSettings, scope = ALL) => api.accounts(scope, settings).slice(0, 3).map((a) => [a.number, a.unexplained, a.gaps, a.rating, a.deleted]);
  // Only gaps above the threshold count: the pair's two gaps are exactly $1'000, the default.
  assert.deepEqual(head(DEFAULT_RULES), [[CHECK.set, 1_000_000n, 1, 'medium', true], [CHECK.gain, 500_000n, 1, 'medium', true], [COMPANY.account, 0n, 0, null, false]]);
  const every: RuleSettings = { ...DEFAULT_RULES, balance: { on: true, money: 0n, items: 0n } };
  assert.deepEqual(head(every), [[CHECK.set, 1_000_000n, 1, 'medium', true], [CHECK.gain, 500_000n, 1, 'medium', true], [CHECK.pair, 200_000n, 2, 'medium', true]]);
  assert.deepEqual(head(every, { from: T0 + 100 * MIN, to: null, server: null })[0], [CHECK.raw, 100_000n, 1, 'high', true]);
  const list = api.accounts(ALL, DEFAULT_RULES);
  assert.deepEqual(list.filter((a) => a.deleted).map((a) => a.number).sort((a, b) => a - b), [12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(list.find((a) => a.number === CHECK.gone), {
    number: CHECK.gone, name: '', company: null, frozen: false, owner: null, ownerName: null, money: 0n, rows: 0, deleted: true, unexplained: 0n, gaps: 0, rating: null,
  });
});

test('one account: company and shared accounts, users with names, every item slot', () => {
  open(fx.master);
  const company = api.account(COMPANY.account, ALL)!;
  assert.deepEqual([company.company, company.owner, company.ownerName, company.createdMs], [COMPANY.name, null, null, T0 - 30 * 24 * 60 * MIN]);
  assert.deepEqual(company.users, [{ uuid: uuid('AdmiralNoor'), name: 'AdmiralNoor', permissions: 7 }]);
  assert.deepEqual(company.items, [{ item: ITEM.money, balance: COMPANY.start, locked: 0n }]);
  const shared = api.account(SHARED.account, ALL)!;
  assert.deepEqual([shared.owner, shared.company, shared.money], [null, null, SHARED.start]);
  assert.deepEqual(shared.users, [
    { uuid: uuid('Tavrik'), name: 'Tavrik', permissions: 7 },
    { uuid: uuid('Quenby'), name: 'Quenby', permissions: 3 },
  ]);
  // Brindle's coal is saved under the old and the current id; the slots come back merged. Money includes the $1'500 of transfer case 5.
  const brindle = api.account(PLAYERS.Brindle.account, ALL)!;
  assert.deepEqual(brindle.items.map((i) => [i.item, i.balance]),
    [[ITEM.money, 11_424_848n], [ITEM.iron, -1_600n], [ALIAS.to, fx.balances.master.get(`3:${ITEM.coal}`)!]]);
  assert.equal(brindle.items.find((i) => i.item === ALIAS.from), undefined);
  assert.deepEqual(api.account(31, ALL)!.items, []);
  assert.equal(api.account(99, ALL), null);
});

test('balances: one point per snapshot minute, cut to the time range', () => {
  open(fx.master);
  assert.deepEqual(api.balances(11, ITEM.money, ALL), [
    [T0 - 24 * 60 * MIN, 50_000_000n], [T0 + 22 * MIN, 5_963_000n], [T0 + 41 * MIN, 594_083_000n],
    [T0 + 51 * MIN, 394_083_000n], [T0 + 52 * MIN, 194_083_000n], [T0 + 56 * MIN, 94_083_000n],
  ]);
  assert.deepEqual(api.balances(11, ITEM.diamond, ALL), [[T0 + 22 * MIN, 300_000n], [T0 + 41 * MIN, 0n]]);
  // Inside a range the series starts with the balance held at its start.
  assert.deepEqual(api.balances(11, ITEM.money, { from: T0 + 45 * MIN, to: T0 + 51 * MIN, server: null }),
    [[T0 + 45 * MIN, 594_083_000n], [T0 + 51 * MIN, 394_083_000n]]);
  assert.deepEqual(api.balances(11, ITEM.money, { from: null, to: T0, server: null }), [[T0 - 24 * 60 * MIN, 50_000_000n]]);
  assert.deepEqual(api.balances(COMPANY.account, ITEM.money, ALL), [[T0 - 24 * 60 * MIN, COMPANY.start]]);
  assert.deepEqual(api.balances(SHARED.account, ITEM.money, { from: T0, to: null, server: null }), [[T0, SHARED.start]]);
  // The last point of every series is what the bank files hold.
  for (const [key, v] of fx.balances.master) {
    const [account, item] = key.split(':').map(Number);
    assert.equal(api.balances(account!, item!, ALL).at(-1)![1], v, key);
  }
  assert.deepEqual(api.balances(31, ITEM.money, ALL), []);
});

test('an old 2.1.2 save: the same accounts, a log without trade or admin rows', () => {
  open(fx.legacy);
  const list = api.accounts(ALL, DEFAULT_RULES);
  for (const a of list) assert.equal(a.money, moneyOf(fx.balances.legacy, a.number), `account ${a.number}`);
  // The unlogged changes are the gaps, rated low; they come first: an admin raise on 27, notes paid in through the ATM
  // converter on 3, notes put back after a withdrawal on 11, the admin actions on 7 and 10. 2.1.2 logged none of them,
  // nor the starting balances, so most accounts have no rows.
  assert.deepEqual(list.map((a) => [a.number, a.rows, a.unexplained, a.rating]).slice(0, 8), [[27, 0, 1_000_000_000n, 'low'], [3, 0, 150_000_000n, 'low'],
    [11, 2, 50_000_000n, 'low'], [7, 0, 20_000_000n, 'low'], [10, 0, 2_500_000n, 'low'], [41, 0, 0n, null], [24, 1, 0n, null], [30, 0, 0n, null]]);
  assert.deepEqual(api.balances(10, ITEM.money, ALL), [[T0 - 24 * 60 * MIN, 10_000_000n], [T0 + 126 * MIN, 7_500_000n]]);
});

test('the server filter counts the log entries made for that server (BS-256); an old log has no origin and keeps all', () => {
  open(fx.master);
  const rows = (server: string | null) => new Map(api.accounts({ ...ALL, server }, DEFAULT_RULES).map((a) => [a.number, a.rows]));
  const all = rows(null), mining = rows('mining-1'), main = rows('survival-main'), hub = rows('nether-hub');
  assert.equal(mining.get(PLAYERS.Tavrik.account), 1); // the second banknote withdrawal
  for (const [account, n] of all) assert.equal(main.get(account)! + mining.get(account)! + hub.get(account)!, n, `account ${account}`);
  open(fx.legacy);
  assert.deepEqual(api.accounts({ ...ALL, server: 'old-world' }, DEFAULT_RULES).map((a) => a.rows), api.accounts(ALL, DEFAULT_RULES).map((a) => a.rows));
});

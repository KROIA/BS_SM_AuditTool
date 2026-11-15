// What to take back: the rules, the cutoffs, an account at each edge, the 2.1.2 removal and its question,
// a player outside the incident who likely paid in notes, and the command lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { dayBefore, keepOf, removeOf, viaTakeOf } from '../../src/engine/query/takeback.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Cutoff, type TakeBackRow } from '../../src/shared/api.ts';
import { commands, floatParts, itemList } from '../../src/shared/commands.ts';
import { buildFixtures, ITEM, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const tavrik = uuidText(PLAYERS.Tavrik.n), quenby = uuidText(PLAYERS.Quenby.n);
const PUMP = `hour-profit:${tavrik}@${T0}`, QUENBY = `order-rate:${quenby}@${T0 + 46 * MIN}`;
const DAY: Cutoff = { kind: 'day', at: null };
let fx: Fixtures;
let n = 0;
const open = (...saves: string[]) => {
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of saves) addSave(s);
};
const take = (id = PUMP, cut = DAY) => api.takeBack(id, cut, DEFAULT_RULES);
const row = (rows: TakeBackRow[], account: number) => rows.find((r) => r.account === account)!;

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-takeback-')), true)));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('the rules: keep, items to remove, the cutoff day', () => {
  assert.equal(keepOf(100n, 40n, 25n), 65n); // the balance at the cutoff plus gains elsewhere
  assert.equal(keepOf(100n, 40n, -25n), 40n); // losses elsewhere do not lower it
  assert.equal(keepOf(30n, 40n, 25n), 30n); // never more than is there
  assert.equal(viaTakeOf(100n, 60n, 25n), 85n); // outside the incident: its notes plus the gain on its markets
  assert.equal(viaTakeOf(100n, 60n, -25n), 60n);
  assert.equal(viaTakeOf(50n, 60n, 25n), 50n);
  assert.equal(removeOf(50n, 150n, 100n), 50n); // what was bought; what was there before stays
  assert.equal(removeOf(50n, 120n, 100n), 20n); // at most what was added since
  assert.equal(removeOf(50n, 90n, 100n), 0n);
  const d = new Date(T0);
  assert.equal(dayBefore(T0), new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - 1);
});

test('float parts: each part a 32-bit float holds exactly, together the amount', () => {
  for (const raw of [1_154_251_539_898n, 829_034_508n, 19_229_241_723n, 6_553_599n, 6_553_600n, 100n, 5n, 1_000_000_000_000_000n]) {
    const parts = floatParts(raw);
    assert.equal(parts.reduce((s, p) => s + p, 0n), raw, String(raw));
    for (const p of parts) assert.equal(BigInt(Math.round(Math.fround(Number(p) / 100) * 100)), p, `${p} survives a float`);
  }
  assert.deepEqual(floatParts(1_154_251_539_898n), [1_154_251_468_800n, 71_098n]); // 11'542'514'688 $ and 710.98 $
  assert.deepEqual(floatParts(0n), []);
});

test('commands: money by name in both versions, set to 0 when nothing is kept, 2.2.0 freezes by account number, items are a list', () => {
  const r = (account: number, name: string, take: bigint, keep = 1n, items: TakeBackRow['items'] = []): TakeBackRow =>
    ({ account, player: { uuid: '', name }, via: null, from: 0, start: 0n, now: take + keep, other: 0n, keep, take, removed: [], items });
  const coal = { item: ITEM.coal, before: 0n, bought: 300n, spent: 1n, now: 500n, remove: 300n };
  // Brindle ends at 0: removing the last 1.23 $ would be refused (the float 1.23 is a bit more than the balance), so set.
  const rows = [r(11, 'Tavrik', 829_034_508n), r(24, 'Ombrelune', 0n, 1n, [coal]), r(7, 'Quenby', 0n), r(3, 'Brindle', 19_229_241_723n, 0n)];
  const money = ['/money remove Tavrik 8290345', '/money remove Tavrik 0.08', '/money set Brindle 0'];
  assert.deepEqual(commands(rows, '2.1.2'), money);
  assert.deepEqual(commands(rows, '2.2.0'), ['/banksystem freeze 11 on', '/banksystem freeze 24 on', '/banksystem freeze 3 on', ...money, '/banksystem freeze 11 off', '/banksystem freeze 24 off', '/banksystem freeze 3 off']);
  assert.deepEqual(itemList(rows, () => 'Coal'), ['Account 24 (Ombrelune): Coal, remove 3, leaves 2']);
});

test('current save: the incident players keep their balance at the cutoff; one has less now than then', () => {
  open(fx.master);
  const t = take();
  assert.equal(t.reason, null);
  assert.equal(t.at, dayBefore(T0));
  assert.equal(t.first, T0 - 1);
  assert.deepEqual(t.rows.map((x) => [x.account, x.via]), [[PLAYERS.Tavrik.account, null], [PLAYERS.Ombrelune.account, null]]);
  for (const x of t.rows) assert.equal(x.keep + x.take, x.now);
  const tav = row(t.rows, PLAYERS.Tavrik.account);
  assert.deepEqual([tav.start, tav.keep], [50_000_000n, 50_000_000n]); // coal lost money: nothing kept from it
  assert.deepEqual(tav.items.map((i) => [i.item, i.before, i.bought, i.now, i.remove]), [[ITEM.coal, 0n, 1_000_000n, 1_000_000n, 1_000_000n]]);
  // Quenby: an admin took 200'000 $ after the cutoff, so she holds less than then. Nothing to take back from the bank.
  const q = row(take(QUENBY).rows, PLAYERS.Quenby.account);
  assert.ok(q.now < q.start);
  assert.deepEqual([q.keep, q.take], [q.now, 0n]);
  assert.match(take('no-such-incident').reason!, /not raised/);
});

test('gains on other markets are kept, and what the player held at the cutoff stays', () => {
  const save = path.join(fx.root, 'edges');
  fs.cpSync(fx.master, save, { recursive: true });
  const bank = new DatabaseSync(path.join(save, 'data/BankSystem/Database/banksystem.db'));
  // A cutoff before Tavrik's coal: he held 4'000 coal then, and sells wheat after it for 50'000 $ (a market
  // outside the incident). Both after the incident's first finding, so the incident keeps its id.
  const at = T0 + 125 * MIN + 30_000; // before the admin's 5M $ (minute 126), which is taken back
  bank.prepare(`INSERT INTO TransactionLog (account_number, actor_uuid, actor_name, kind, type_code, item_id, amount, ts, source_kind, tag, money_amount, price, currency_item)
    VALUES (?, ?, 'Tavrik', 'TRADE_SELL', 5, ?, 1000, ?, 'STOCKMARKET', 'CLOSE', 5000000, 500000, ?)`).run(PLAYERS.Tavrik.account, tavrik, ITEM.wheat, at + MIN, ITEM.money);
  bank.prepare('INSERT INTO BalanceHistory (account_number, item_id, balance, locked_balance, time) VALUES (?, ?, 400000, 0, ?)').run(PLAYERS.Tavrik.account, ITEM.coal, at - 1);
  bank.close();
  open(save);
  const tav = row(take(PUMP, { kind: 'custom', at }).rows, PLAYERS.Tavrik.account);
  assert.equal(tav.other, 5_000_000n - 1_360_000n); // wheat earned, coal lost
  assert.ok(tav.now > tav.start + tav.other);
  assert.deepEqual([tav.keep, tav.take], [tav.start + tav.other, tav.now - tav.start - tav.other]);
  assert.deepEqual(tav.items.map((i) => [i.item, i.before, i.bought, i.now, i.remove]), [[ITEM.coal, 400_000n, 1_000_000n, 1_000_000n, 600_000n]]);
});

test('2.1.2: the admin removal is a question, its answer is stored and changes no amount; notes paid in by another player', () => {
  open(fx.legacy);
  const t = take(QUENBY), q = row(t.rows, PLAYERS.Quenby.account);
  assert.equal(t.legacy, true);
  assert.deepEqual(q.removed, [{ key: `${PLAYERS.Quenby.account}@${T0 + 61 * MIN}`, amount: 20_000_000n, from: T0 + 61 * MIN, to: T0 + 121 * MIN }]);
  api.setChoices({ cutoff: DAY, answers: { [q.removed[0]!.key]: 'yes' }, order: [], style: 'admin', lang: 'en' });
  assert.equal(api.caseData().choices.answers[q.removed[0]!.key], 'yes');
  assert.deepEqual(take(QUENBY), t);

  // Brindle paid in 1.5M $ of the notes Tavrik took out after the cutoff: that is what traces to the incident, nothing else
  // of their account (they did not trade its markets).
  const b = take().rows.at(-1)!;
  assert.deepEqual([b.account, b.via?.uuid, b.via?.notes, b.removed, b.items], [PLAYERS.Brindle.account, tavrik, 150_000_000n, [], []]);
  assert.deepEqual([b.take, b.keep], [150_000_000n, b.now - 150_000_000n]);
  // Right before the first finding gives the same here: nothing moved between the two.
  assert.deepEqual(take(PUMP, { kind: 'first', at: null }).rows.map((x) => x.take), take().rows.map((x) => x.take));
  const custom = take(PUMP, { kind: 'custom', at: T0 + 30 * MIN });
  assert.equal(custom.at, T0 + 30 * MIN);
});

test('without a save, a sentence', () => {
  init(path.join(fx.root, `workspace-${++n}`));
  assert.match(take().reason!, /No save/);
});

// The timeline of the money flow (AT-59): every money entry as a move between two places, one move per transfer, and
// notes taken out and paid into another account at the exact amount as one move through the world, an estimate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope, type TimelineMove } from '../../src/shared/api.ts';
import { buildFixtures, ITEM, PLAYERS, SHARED, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const tavrik = uuidText(PLAYERS.Tavrik.n);
let fx: Fixtures;

before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-timeline-')));
  // Tavrik pays 2M $ of notes into the shared account a minute after taking 2M $ out of his own (minute 51).
  const save = path.join(fx.root, 'carried');
  fs.cpSync(fx.master, save, { recursive: true });
  const db = new DatabaseSync(path.join(save, 'data/BankSystem/Database/banksystem.db'));
  db.prepare(`INSERT INTO TransactionLog (account_number, actor_uuid, actor_name, kind, type_code, item_id, amount, ts, source_kind)
    VALUES (?, ?, 'Tavrik', 'DEPOSIT', 1, ?, 200000000, ?, 'PLAYER')`).run(SHARED.account, tavrik, ITEM.money, T0 + 52 * MIN);
  db.close();
  init(path.join(fx.root, 'workspace'));
  addSave(save);
});
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

const brief = (m: TimelineMove) => [m.kind, m.from, m.to, m.amount, m.basis];
const at = (moves: TimelineMove[], minute: number) => moves.filter((m) => m.time >= T0 + minute * MIN && m.time < T0 + (minute + 1) * MIN).map(brief);

test('notes paid into another account at the amount taken out shortly before are one move through the world', () => {
  const { moves, players, reason } = api.flowTimeline(ALL, DEFAULT_RULES);
  assert.equal(reason, null);
  const carried = moves.find((m) => m.until !== null)!;
  assert.deepEqual(brief(carried), ['notes', PLAYERS.Tavrik.account, SHARED.account, 200_000_000n, 'estimate']);
  assert.deepEqual([carried.time, carried.until, carried.by, carried.paidInBy, carried.rows.length], [T0 + 51 * MIN + 500, T0 + 52 * MIN, tavrik, tavrik, 2]);
  assert.deepEqual(players.find((p) => p.uuid === tavrik)?.name, 'Tavrik');
  // The first 2M $ has no deposit of its amount: it left for the world. Ombrelune's 3M $ came from it.
  assert.deepEqual(at(moves, 50), [['notes', PLAYERS.Tavrik.account, 'world', 200_000_000n, 'proven']]);
  assert.deepEqual(at(moves, 70), [['notes', 'world', PLAYERS.Ombrelune.account, 300_000_000n, 'proven']]);
  // A transfer writes a row on each account: one move with both rows.
  const sent = moves.filter((m) => m.kind === 'transfer' && m.from === PLAYERS.Tavrik.account && m.to === PLAYERS.Ombrelune.account);
  assert.deepEqual(sent.map((m) => [m.amount, m.rows.length]), [[100_000_000n, 2]]);
  assert.deepEqual(at(moves, 120), [['admin', PLAYERS.Quenby.account, 'admin', 20_000_000n, 'proven']]);
  assert.ok(moves.some((m) => m.kind === 'trade' && m.to === 'markets'), 'purchases');
});

test('with every item: each trade has its money side and its goods side under the same id, the other way round (AT-65)', () => {
  assert.ok(api.flowTimeline(ALL, DEFAULT_RULES).moves.every((m) => m.item === ITEM.money), 'money only by default');
  const { moves } = api.flowTimeline(ALL, DEFAULT_RULES, true);
  const id = (m: TimelineMove) => `${m.orders[0] ?? ''}|${m.rows[0] ?? ''}`;
  const trades = moves.filter((m) => m.kind === 'trade'), cash = trades.filter((m) => m.item === ITEM.money);
  assert.ok(cash.length > 60);
  for (const m of cash) {
    const goods = trades.filter((g) => g.item === m.market && id(g) === id(m));
    assert.equal(goods.length, 1, `the goods side of ${id(m)}`);
    assert.deepEqual([goods[0]!.from, goods[0]!.to, goods[0]!.market], [m.to, m.from, m.market]);
  }
  assert.ok(trades.some((m) => m.item === ITEM.diamond && m.to === PLAYERS.Tavrik.account && m.amount === 10_000n), 'Tavrik\'s diamonds');
  // Diamonds paid in: from the world, as the item itself.
  assert.ok(moves.some((m) => m.kind === 'notes' && m.item === ITEM.diamond && m.from === 'world'));
});

test('the time range keeps a carried move whose deposit is in it', () => {
  const { moves } = api.flowTimeline({ from: T0 + 52 * MIN, to: T0 + 53 * MIN, server: null }, DEFAULT_RULES);
  assert.deepEqual(moves.map(brief), [['notes', PLAYERS.Tavrik.account, SHARED.account, 200_000_000n, 'estimate']]);
});

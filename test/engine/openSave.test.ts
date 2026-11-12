import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import type { SaveSummary } from '../../src/shared/api.ts';
import { buildFixtures, type Fixtures } from '../fixtures/build.ts';

let fx: Fixtures;
before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-test-')))));
after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

const rowsOf = (save: SaveSummary, source: string) => Object.fromEntries(save.sources.find((s) => s.id === source)!.tables.map((t) => [t.name, t.rows]));
/** Every file below dir with its size and time of last change. */
const listing = (dir: string) =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f} ${s.size} ${s.mtimeMs}`; });

test('the master of a current network: role, format and every table with the rows the builder wrote', () => {
  const save = api.openSave(fx.master);
  assert.equal(save.role, 'MASTER');
  assert.equal(save.roleAssumed, false);
  assert.equal(save.generation, 'current');
  assert.equal(save.name, 'survival-main');
  assert.deepEqual(save.sources.map((s) => `${s.id}:${s.status}`), ['bank:read', 'market:read', 'bankDiag:read', 'marketDiag:read']);
  const w = fx.rows.master!;
  assert.deepEqual(rowsOf(save, 'market'), { MarketPrice: w.MarketPrice, OrderHistory: w.OrderHistory });
  assert.deepEqual(rowsOf(save, 'bank'), { BalanceHistory: w.BalanceHistory, PayoutHistory: 0, SuspicionFlag: w.SuspicionFlag, TransactionLog: w.TransactionLog });
  assert.deepEqual(rowsOf(save, 'bankDiag'), { Meta: 3, NoteFlow: w.NoteFlow, TransferJournal: 0 });
  assert.deepEqual(rowsOf(save, 'marketDiag'), { Meta: 2, OrderOrigin: w.OrderOrigin });
  assert.equal(w.MarketPrice, 8 * 160);
  assert.equal(w.OrderHistory, 86);
  assert.deepEqual(save.warnings, []);
});

test('a slave is named after its slave id and is expected to have only the journal file', () => {
  const save = api.openSave(fx.slaves[0]!);
  assert.equal(save.role, 'SLAVE');
  assert.equal(save.name, 'mining-1');
  assert.deepEqual(save.sources.map((s) => `${s.id}:${s.status}`), ['bank:none', 'market:none', 'bankDiag:read', 'marketDiag:none']);
  assert.equal(rowsOf(save, 'bankDiag').TransferJournal, 4);
});

test('an old 2.1.2 save: recognised as such, role assumed, and no complaint about files that version never wrote', () => {
  const save = api.openSave(path.join(fx.legacy, 'data')); // the data folder itself may be picked too
  assert.equal(save.generation, 'legacy');
  assert.equal(save.role, 'MASTER');
  assert.equal(save.roleAssumed, true);
  assert.equal(save.name, 'old-world');
  assert.deepEqual(save.sources.map((s) => `${s.id}:${s.status}`), ['bank:read', 'market:read', 'bankDiag:none', 'marketDiag:none']);
  assert.equal(save.warnings.length, 1);
});

test('opening a save leaves every file of it untouched and adds none', () => {
  const before = listing(fx.master);
  api.openSave(fx.master);
  assert.deepEqual(listing(fx.master), before);
});

test('a master without its market database says so, and a damaged file is reported instead of stopping the load', () => {
  const dir = path.join(fx.root, 'broken');
  fs.cpSync(fx.master, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'data/StockMarket/Database/stockdata.db'));
  fs.writeFileSync(path.join(dir, 'data/BankSystem/Database/banksystem.db'), 'this is not a database');
  const save = api.openSave(dir);
  assert.deepEqual(save.sources.map((s) => `${s.id}:${s.status}`), ['bank:damaged', 'market:missing', 'bankDiag:read', 'marketDiag:read']);
  assert.equal(save.warnings.length, 1);
});

test('a folder without mod data is refused in plain words', () => {
  const empty = path.join(fx.root, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => api.openSave(empty), /holds no BankSystem or StockMarket data/);
});

test('the engine reads SQLite and keeps 64-bit numbers exact', () => {
  const check = api.selfCheck();
  assert.match(check.sqlite, /^3\./);
  assert.equal(check.largest, 2n ** 63n - 1n);
});

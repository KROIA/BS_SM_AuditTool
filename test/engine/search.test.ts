import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { buildFixtures, COMPANY, ITEM, PLAYERS, SHARED, T0, TRANSFER_CASES, uuidText, type Fixtures } from '../fixtures/build.ts';

let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-search-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('search finds nothing without a save or without text', () => {
  init(path.join(fx.root, 'empty-workspace'));
  assert.deepEqual(api.search('tav'), { players: [], accounts: [], items: [], orders: [], transfers: [] });
  open(fx.master);
  assert.deepEqual(api.search('   '), { players: [], accounts: [], items: [], orders: [], transfers: [] });
  assert.deepEqual(api.search('zzz-nothing'), { players: [], accounts: [], items: [], orders: [], transfers: [] });
});

test('search finds players by name and by the start of the UUID, names that start with the text first', () => {
  open(fx.master);
  assert.deepEqual(api.search('TAV').players, [{ uuid: uuidText(PLAYERS.Tavrik.n), name: 'Tavrik' }]);
  assert.deepEqual(api.search('ik').players.map((p) => p.name).sort(), ['Mikko_82', 'Tavrik']);
  assert.deepEqual(api.search('b').players.map((p) => p.name), ['Brindle', 'Quenby', 'Ombrelune']);
  assert.deepEqual(api.search('mikko 8').players.map((p) => p.name), ['Mikko_82'], 'a space finds an underscore');
  assert.deepEqual(api.search(uuidText(PLAYERS.Brindle.n)).players.map((p) => p.name), ['Brindle']);
  assert.equal(api.search('a1b2c3d4').players.length, 5, 'every fixture UUID starts alike; the list is cut at five');
  assert.deepEqual(api.search('%').players, []);
});

test('search finds accounts by number and by name, and items by name and id', () => {
  open(fx.master);
  assert.deepEqual(api.search(String(SHARED.account)).accounts[0], { number: SHARED.account, name: SHARED.name });
  assert.deepEqual(api.search('northreach').accounts, [{ number: COMPANY.account, name: COMPANY.name }]);
  assert.deepEqual(api.search('iron ingot').items, [{ id: ITEM.iron, name: 'minecraft:iron_ingot', money: false }]);
  assert.equal(api.search(String(ITEM.gold)).items[0]!.id, ITEM.gold);
  assert.ok(api.search('ingot').items.length >= 2);
});

test('search finds an order by its id, also written as the mod writes it, and on an old save by its row id', () => {
  open(fx.master);
  const [first] = api.search('1').orders;
  assert.equal(first!.orderId, 1);
  assert.equal(first!.name, 'Brindle');
  assert.equal(first!.time, T0 + 5 * 60_000 + 1200);
  assert.equal(api.search('sm:order:1').orders[0]!.id, first!.id);
  assert.deepEqual(api.search('9999').orders, []);
  assert.deepEqual(api.search('tav').orders, []);

  open(fx.legacy);
  const old = api.search('1').orders;
  assert.equal(old.length, 1);
  assert.equal(old[0]!.orderId, null);
  assert.equal(old[0]!.id, 1);
});

test('search finds a transfer by its whole id or its first 8 characters or more, only with the slaves loaded', () => {
  open(fx.master);
  const id = TRANSFER_CASES[0]!.id;
  assert.deepEqual(api.search(id).transfers, [], 'the master alone knows no transfers');
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of [fx.master, ...fx.slaves]) addSave(s);
  assert.deepEqual(api.search(id.toUpperCase()).transfers.map((t) => t.id), [id]);
  assert.equal(api.search(id.slice(0, 8)).transfers.length, 5, 'every fixture id starts alike; the list is cut at five');
  assert.deepEqual(api.search(id.slice(0, 7)).transfers, [], 'a prefix needs 8 characters');
  assert.deepEqual(api.search('c0000000-0000-4000-8000-ffffffffffff').transfers, []);
});

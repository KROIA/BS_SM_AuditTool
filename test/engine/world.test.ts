// The player files (AT-35, DESIGN_SPEC 8.7): what the reader takes from them and what it refuses, the query over the
// network, and the banknote rule that compares them with the bank's note count.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { LIMITS, readPlayerFiles, worthOf } from '../../src/engine/save/players.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope } from '../../src/shared/api.ts';
import { describe } from '../../src/shared/finding.ts';
import { buildFixtures, ITEM, PLAYERS, playerNbt, shulkerOf, stackOf, uuidText, WORLD, type Fixtures } from '../fixtures/build.ts';
import { comp, int, list, nbtFile, str } from '../fixtures/nbt.ts';

const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
const open = (...saves: string[]) => {
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of saves) addSave(s);
};
const uuid = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-world-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('what one money item is worth by its registry name; any other item is worth nothing', () => {
  assert.equal(worthOf('banksystem:money'), 100n);
  assert.equal(worthOf('banksystem:money100'), 10_000n);
  assert.equal(worthOf('banksystem:money1000000'), 100_000_000n);
  assert.equal(worthOf('banksystem:money_cent50'), 50n);
  for (const name of ['banksystem:moneybag', 'banksystem:money12345678', 'minecraft:diamond', 'banksystem:money_cent']) assert.equal(worthOf(name), null, name);
});

test('the reader: inventory, ender chest, a shulker inside the ender chest, a bundle, the old layout; .dat_old and other names left out', () => {
  const got = readPlayerFiles(path.join(fx.master, 'playerdata'));
  assert.deepEqual(got.files.map((f) => f.uuid).sort(), [uuid('Brindle'), uuid('Mikko_82'), uuid('AdmiralNoor'), uuid('Quenby')].sort());
  assert.ok(got.files.every((f) => f.ok));
  assert.equal(got.bad, 0);
  const q = got.stacks.filter((s) => s.player === uuid('Quenby'));
  const find = (item: string, place: string) => q.find((s) => s.item === item && s.place === place);
  assert.deepEqual(q.filter((s) => s.item === 'banksystem:money100000').map((s) => [s.place, s.path, s.count]),
    [['ender chest', ['minecraft:shulker_box'], 6], ['ender chest', [], 1]]);
  assert.deepEqual(find('banksystem:money100', 'inventory')?.path, ['minecraft:bundle']);
  assert.equal(find('banksystem:money100', 'inventory')?.worth, 10_000n);
  const renamed = find('banksystem:money1000', 'inventory')!;
  assert.equal(renamed.plain, false); // the bank refuses a note with components
  assert.equal(renamed.worth, null);
  const old = got.stacks.filter((s) => s.player === uuid('Brindle'));
  assert.deepEqual(old.map((s) => [s.place, s.path, s.item, s.count]).sort(),
    [['ender chest', ['minecraft:shulker_box'], 'banksystem:money1000', 3], ['ender chest', [], 'minecraft:shulker_box', 1], ['inventory', [], 'banksystem:money', 40]].sort());
});

test('a file that breaks a limit or is not NBT is skipped whole and counted; one with tags of the wrong type gives nothing', () => {
  const dir = fs.mkdtempSync(path.join(fx.root, 'hostile-'));
  const file = (n: number, data: Buffer) => fs.writeFileSync(path.join(dir, uuidText(100 + n) + '.dat'), data);
  const nest = (levels: number) => {
    let s = stackOf('minecraft:diamond', 1);
    for (let i = 0; i < levels; i++) s = shulkerOf([s]);
    return playerNbt([], [s]);
  };
  file(1, nest(LIMITS.depth)); // 8 containers deep: read
  file(2, nest(LIMITS.depth + 1)); // 9: refused
  file(3, playerNbt(Array.from({ length: LIMITS.stacks + 1 }, () => stackOf('minecraft:dirt', 1)), [])); // too many stacks
  const huge = Buffer.from(nbtFile({ Inventory: list([]) }, false));
  huge[huge.length - 6] = 10; // a list of compounds
  huge.writeInt32BE(0x7fffffff, huge.length - 5); // that says it has 2^31 entries
  file(4, huge);
  file(5, nbtFile({ Inventory: int(5), EnderItems: list([str('minecraft:diamond')]), Other: list([comp({ id: int(3), count: str('64') })]) }));
  const whole = nest(1);
  file(6, whole.subarray(0, whole.length - 10)); // cut off
  file(7, Buffer.from('PK\x03\x04 not a gzip file'));
  const got = readPlayerFiles(dir);
  const ok = Object.fromEntries(got.files.map((f) => [Number.parseInt(f.uuid.slice(-3), 16) - 100, f.ok]));
  assert.deepEqual(ok, { 1: true, 2: false, 3: false, 4: false, 5: true, 6: false, 7: false });
  assert.equal(got.bad, 5);
  assert.deepEqual(got.stacks.filter((s) => s.item === 'minecraft:diamond').map((s) => s.path.length), [LIMITS.depth]);
  assert.equal(got.stacks.filter((s) => s.player === uuidText(105)).length, 0);
});

test('import: a save with unreadable player files says how many; the cache keeps every file and stack', () => {
  open(fx.master, ...fx.slaves);
  const mining = api.workspace().saves.find((s) => s.name === 'mining-1')!;
  assert.ok(mining.warnings.includes('2 player files could not be read (damaged, not NBT, too large or nested too deep). What those players carry is not counted.'), mining.warnings.join('\n'));
  const main = api.workspace().saves.find((s) => s.name === 'survival-main')!;
  assert.ok(!main.warnings.some((w) => w.includes('player file')));
});

test('worldItems: notes per player and place over the network, valuables, refused notes, and the players without a file', () => {
  open(fx.master, ...fx.slaves);
  const w = api.worldItems();
  assert.equal(w.reason, null);
  assert.equal(w.notes, WORLD.found);
  assert.equal(w.inventory, WORLD.inventory);
  assert.equal(w.enderChest, WORLD.enderChest);
  assert.equal(w.files, 5); // four on the master, Mikko_82's on mining-1
  assert.deepEqual(w.without, ['nether-hub']);
  assert.deepEqual(w.altered, { stacks: 1, count: 1 });
  assert.deepEqual(w.players.map((p) => [p.player.name, p.notes]), [
    ['Quenby', 70_300_000n], ['Mikko_82', 10_000_000n], ['Brindle', 304_000n], ['AdmiralNoor', 20_000n]]);
  const quenby = w.players[0]!;
  assert.equal(quenby.enderChest, 70_000_000n);
  assert.deepEqual(quenby.stacks.find((s) => s.path.length && s.place === 'ender chest'),
    { server: 'survival-main', place: 'ender chest', path: ['minecraft:shulker_box'], item: 'banksystem:money100000', itemId: null, count: 6, value: 60_000_000n });
  // Diamonds and wheat have a market; dirt and the shulker box do not.
  assert.deepEqual(quenby.valuables.map((s) => [s.item, s.itemId, s.count]), [['minecraft:diamond', ITEM.diamond, 64]]);
  assert.deepEqual(w.players.find((p) => p.player.name === 'Mikko_82')!.valuables.map((s) => s.item), ['minecraft:wheat']);
  assert.deepEqual(w.players.find((p) => p.player.name === 'Mikko_82')!.stacks.map((s) => s.server), ['mining-1']);
  // Tavrik has only a backup file; Ombrelune's only file is not NBT. Quenby's damaged file on mining-1 does not count: the master's was read.
  assert.deepEqual(w.missing.map((p) => p.name), ['Ombrelune', 'Tavrik']);
  assert.equal(w.unnamed, 0); // every UUID of the fixture's orders and log has a name
  assert.deepEqual(w.unreadable.map((p) => p.name), ['Ombrelune']);
});

test('worldItems without player files, and without bank data', () => {
  open(fx.exported);
  assert.match(api.worldItems().reason ?? '', /None of the loaded saves has player files/);
  open(fx.slaves[0]!);
  assert.match(api.worldItems().reason ?? '', /No save with bank data/);
});

test('the banknote rule: notes missing beyond the threshold give one medium estimate; a higher threshold none', () => {
  open(fx.master, ...fx.slaves);
  const count = api.banknotes(ALL).outstanding;
  const f = api.findings(ALL, DEFAULT_RULES).findings.filter((x) => x.rule === 'banknotes');
  assert.equal(f.length, 1);
  const x = f[0]!;
  assert.equal(x.id, 'banknotes:count');
  assert.equal(x.level, 'medium');
  assert.equal(x.basis, 'estimate');
  assert.equal(x.facts.outstanding, count);
  assert.equal(x.facts.found, WORLD.found);
  assert.equal(x.facts.difference, WORLD.found - count);
  assert.deepEqual(x.measured, { value: count - WORLD.found, threshold: DEFAULT_RULES.banknotes.money, unit: 'money' });
  assert.deepEqual(x.facts.missing, ['Ombrelune', 'Tavrik']);
  const words = describe(x, { itemName: (id) => `item ${id}`, isMoney: () => true });
  assert.match(words.title, /of banknotes the bank handed out were not found/);
  assert.match(words.summary, /player files and ender chests only; the region scan has not been run, so notes in chests and other blocks are not counted/);
  assert.match(words.summary, /2 players who traded or used the bank have no readable player file: Ombrelune, Tavrik\./);
  assert.match(words.summary, /The save "nether-hub" has no player files\./);
  const higher = { ...DEFAULT_RULES, banknotes: { on: true, money: count - WORLD.found } };
  assert.deepEqual(api.findings(ALL, higher).findings.filter((x) => x.rule === 'banknotes'), []);
});

test('the banknote rule on a 2.1.2 save compares with the corrected count, and finds nothing', () => {
  open(fx.legacy);
  assert.equal(api.banknotes(ALL).outstanding, WORLD.legacy);
  assert.equal(api.worldItems().notes, WORLD.legacy);
  const r = api.findings(ALL, DEFAULT_RULES);
  assert.deepEqual(r.findings.filter((x) => x.rule === 'banknotes'), []);
  assert.deepEqual(r.rules.find((x) => x.rule === 'banknotes'), { rule: 'banknotes', on: true, found: 0, notApplicable: null });
});

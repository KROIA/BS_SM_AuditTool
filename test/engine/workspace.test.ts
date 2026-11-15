import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { addSave, init, mainData, reload, removeSave, workspace } from '../../src/engine/workspace.ts';
import type { Progress } from '../../src/shared/api.ts';
import { buildFixtures, type Fixtures } from '../fixtures/build.ts';

let fx: Fixtures;
before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-workspace-')))));
after(() => {
  init(fx.root); // closes the open cache database, which Windows would not let go of otherwise
  fs.rmSync(fx.root, { recursive: true, force: true });
});

let n = 0;
const events: Progress[] = [];
/** Starts the engine's workspace in a folder, as the program does at start-up, and records its progress messages. */
const open = (dir: string) => {
  events.length = 0;
  init(dir, (p) => events.push(p));
};
const fresh = () => path.join(fx.root, `workspace-${++n}`);
const names = () => workspace().saves.map((s) => s.name);
/** The cache files with their time of last change. */
const caches = (dir: string) => fs.readdirSync(path.join(dir, 'cache')).sort().map((f) => `${f} ${fs.statSync(path.join(dir, 'cache', f)).mtimeMs}`);

test('saves come back after a restart, from the cache, without reading them again', () => {
  const dir = fresh();
  open(dir);
  addSave(fx.master);
  addSave(fx.slaves[0]!);
  assert.ok(events.length > 0);
  assert.deepEqual(workspace().warnings, []);
  const cached = caches(dir);
  assert.equal(cached.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')).saves, [fx.master, fx.slaves[0]]);

  open(dir);
  assert.deepEqual(names(), ['survival-main', 'mining-1']);
  assert.deepEqual(events, []);
  assert.deepEqual(caches(dir), cached);
  addSave(fx.master); // added again, unchanged
  assert.deepEqual(events, []);
  assert.deepEqual(names(), ['mining-1', 'survival-main']);
});

test('a changed file of a save makes it be read again, even while its cache is open', () => {
  const save = path.join(fx.root, 'changing');
  fs.cpSync(fx.master, save, { recursive: true });
  open(fresh());
  addSave(save);
  assert.equal((mainData()!.prepare('SELECT count(*) AS n FROM player').get() as { n: number }).n, 6);
  events.length = 0;
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(save, 'data/BankSystem/Bank_data/users/chunk_0.nbt'), later, later);
  addSave(save);
  assert.ok(events.length > 0);
  assert.equal((mainData()!.prepare('SELECT count(*) AS n FROM player').get() as { n: number }).n, 6);

  // Read again (the Saves screen's button): unchanged, it comes from the cache; changed, it is imported anew.
  events.length = 0;
  assert.deepEqual(reload().saves.map((s) => s.path), [save]);
  assert.deepEqual(events, []);
  const latest = new Date(Date.now() + 120_000);
  fs.utimesSync(path.join(save, 'data/BankSystem/Bank_data/users/chunk_0.nbt'), latest, latest);
  reload();
  assert.ok(events.length > 0);
  assert.equal((mainData()!.prepare('SELECT count(*) AS n FROM player').get() as { n: number }).n, 6);
});

test('a second master is refused with a sentence, and the first stays loaded', () => {
  open(fresh());
  addSave(fx.master);
  assert.throws(() => addSave(fx.legacy), {
    message: '"survival-main" is already loaded as the server with the bank and market data. One workspace holds one network: remove it first to look at "old-world".',
  });
  assert.deepEqual(names(), ['survival-main']);
  // The same folder spelled differently is the same save, not a second master.
  addSave(fx.master + path.sep);
  addSave(path.join(fx.master, 'data'));
  assert.deepEqual(names(), ['survival-main']);
  assert.equal(workspace().saves[0]!.path, path.resolve(fx.master));
  assert.ok(mainData());
});

test('removing a save drops it and its cache; a slave alone is told its master is missing', () => {
  const dir = fresh();
  open(dir);
  addSave(fx.master);
  addSave(fx.slaves[0]!);
  const w = removeSave(fx.master);
  assert.deepEqual(w.saves.map((s) => s.name), ['mining-1']);
  assert.equal(caches(dir).length, 1);
  assert.deepEqual(w.warnings, ['"mining-1" is a slave, and its master is not loaded. Bank and market data are missing.']);
  assert.equal(mainData(), null);
  open(dir);
  assert.deepEqual(names(), ['mining-1']);
});

test('network warnings: copies taken hours apart, and two saves of the same world', () => {
  open(fresh());
  addSave(fx.master);
  assert.deepEqual(addSave(fx.slaves[1]!).warnings, ['The copies were taken more than an hour apart. What happened in between can only be checked on the newer ones.']);

  open(fresh());
  const copy = path.join(fx.root, 'mining-1-copy');
  fs.cpSync(fx.slaves[0]!, copy, { recursive: true });
  addSave(fx.slaves[0]!);
  const w = addSave(copy);
  assert.ok(w.warnings.includes('"mining-1" and "mining-1" have the same server id. One of them is a copy of the other world.'));
});

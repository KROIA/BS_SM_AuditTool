// The region scan (AT-36, DESIGN_SPEC 6.7 and 8.7): the Anvil reader and its limits, what it finds in blocks and entities,
// the background scan with stop and continue, its coverage, and the banknote rule's sentence that follows it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { worthOf } from '../../src/engine/save/players.ts';
import { readRegion, scanRegion, type Find } from '../../src/engine/save/region.ts';
import { addSave, init, removeSave } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Progress, type Scope } from '../../src/shared/api.ts';
import { describe } from '../../src/shared/finding.ts';
import { buildFixtures, chunkRoot, ITEM, NOTE, packed, PLAYERS, regionFile, SCAN, shulkerOf, stackOf, uuidText, WORLD, type Fixtures } from '../fixtures/build.ts';
import { comp, int, list, nbtFile, str } from '../fixtures/nbt.ts';

const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
let events: Progress[] = [];
const open = (...saves: string[]) => {
  events = [];
  init(path.join(fx.root, `workspace-${++n}`), (p) => events.push(p));
  for (const s of saves) addSave(s);
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 800 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(ok(), 'timed out');
};
const scanned = async () => {
  api.startScan();
  await until(() => !api.scanStatus().running);
};
const keep = (f: { item: string; plain: boolean }) => worthOf(f.item) !== null || (f.plain && ['minecraft:diamond', 'minecraft:wheat'].includes(f.item));
const names = new Map([[NOTE, 'banksystem:money100'], [ITEM.money, 'banksystem:money']]);
const region = () => path.join(fx.master, 'region', 'r.-2.-2.mca');
const words = (f: Parameters<typeof describe>[0]) => describe(f, { itemName: (id) => `item ${id}`, isMoney: () => true });

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-scan-')))));
after(() => {
  init(fx.root); // ends any scan and its workers
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('the reader: zlib, gzip, uncompressed and .mcc chunks read; a damaged chunk, an LZ4 chunk and a length past its sectors counted', () => {
  const got = scanRegion(region(), keep, (id) => names.get(id));
  assert.deepEqual([got.chunks, got.damaged, got.lz4, got.tooLarge], [3, 2, 1, 0]);
  const at = (place: string) => got.finds.filter((f) => f.place === place);
  const brief = (f: Find) => [f.item, f.count, f.plain, f.worth, f.path];
  assert.deepEqual(at('minecraft:chest').filter((f) => f.x === SCAN.chest.x).map(brief).sort(), [
    ['banksystem:money1000', 1, false, null, []], // renamed: kept as altered
    ['banksystem:money1000', 20, true, 100_000n, []],
    ['minecraft:diamond', 64, true, null, []], // dirt is no valuable: not kept
  ]);
  assert.deepEqual(at('minecraft:barrel').map(brief), [['banksystem:money100', 50, true, 10_000n, ['minecraft:shulker_box']]]);
  // The stockpile keeps item numbers: the main save's names value them; an unknown number is kept without a value.
  assert.deepEqual(at('banksystem:money_stockpile_block_entity').map(brief), [
    ['banksystem:money100', 30, true, 10_000n, []], ['banksystem:money', 500, true, 100n, []], ['#99', 5, true, null, []]]);
  assert.deepEqual(at('banksystem:banksystem_display_block_entity'), []); // icons
  assert.deepEqual(at('banksystem:bank_terminal_block_entity').map((f) => [f.owner, f.item, f.count]), [[uuidText(PLAYERS.Quenby.n), 'banksystem:money100', 10]]);
  assert.deepEqual(at('banksystem:bank_upload_block_entity').map((f) => [f.account, f.item, f.count]), [[PLAYERS.Mikko_82.account, 'banksystem:money50', 4]]);
  assert.deepEqual(at('banksystem:bank_download_block_entity').map((f) => [f.account, f.item, f.count]), [[PLAYERS.Mikko_82.account, 'banksystem:money10', 3]]); // I, not the old Items
  assert.deepEqual(at('minecraft:hopper').map((f) => [f.x, f.item, f.count]), [[-830, 'banksystem:money100', 7]]); // from c.-52.-64.mcc
  assert.deepEqual(got.finds.filter((f) => f.x === -820).map(brief), [['banksystem:money5', 2, true, 500n, []]]); // Level.TileEntities, Count
});

test('the reader on entities: a dropped note, a minecart and its rider, a villager\'s inventory and offers', () => {
  const got = scanRegion(path.join(fx.master, 'entities', 'r.-2.-2.mca'), keep, () => undefined);
  assert.equal(got.chunks, 1);
  const brief = (f: Find) => [f.place, f.source, f.x, f.y, f.z, f.item, f.count];
  assert.deepEqual(got.finds.map(brief).sort(), [
    ['minecraft:armor_stand', 'entity', -861, 65, -1013, 'minecraft:diamond', 3],
    ['minecraft:chest_minecart', 'entity', -861, 64, -1013, 'banksystem:money100', 5],
    ['minecraft:item', 'entity', -871, 63, -1016, 'banksystem:money1000', 1],
    ['minecraft:villager', 'entity', -881, 64, -1011, 'minecraft:wheat', 5],
    ['minecraft:villager', 'offer', -881, 64, -1011, 'banksystem:money10', 2],
    ['minecraft:villager', 'offer', -881, 64, -1011, 'banksystem:money100', 3],
    ['minecraft:villager', 'offer', -881, 64, -1011, 'minecraft:wheat', 1],
  ].sort());
});

test('the reader\'s limits: a file shorter than its header, sectors outside the file, a missing .mcc, too much unpacked or nested', () => {
  const dir = fs.mkdtempSync(path.join(fx.root, 'hostile-')), file = path.join(dir, 'r.0.0.mca');
  fs.writeFileSync(file, Buffer.alloc(100, 1));
  assert.throws(() => readRegion(file, () => {}), /shorter than its header/);
  let nest = stackOf('minecraft:diamond', 1);
  for (let i = 0; i < 9; i++) nest = shulkerOf([nest]); // nested one level more than the walker takes
  regionFile(file, [
    { index: 0, body: Buffer.concat([Buffer.from([2]), zlib.deflateSync(Buffer.alloc(65 * 1024 * 1024))]) }, // unpacks past 64 MB
    { index: 1, body: packed(2, chunkRoot([comp({ id: str('minecraft:chest'), x: int(0), y: int(0), z: int(0), Items: list([comp(nest)]) })])) },
    { index: 2, body: packed(130, {}) }, // its c.2.0.mcc does not exist
    { index: 3, body: packed(2, chunkRoot([])) },
  ]);
  const raw = fs.readFileSync(file);
  raw.writeUInt32BE((5000 << 8) | 1, 4 * 4); // chunk 4 points far past the end
  fs.writeFileSync(file, raw);
  assert.deepEqual(scanRegion(file, () => true, () => undefined), { chunks: 1, damaged: 2, lz4: 0, tooLarge: 2, finds: [] });
  // A copy of a running server's world: the last sector is not padded yet, the chunk's data is all there. Cut one byte
  // more and its length runs past the file.
  const chest = packed(2, chunkRoot([comp({ id: str('minecraft:chest'), x: int(1), y: int(2), z: int(3), Items: list([comp(stackOf('banksystem:money100', 4))]) })]));
  regionFile(file, [{ index: 0, body: chest }]);
  const unpadded = fs.readFileSync(file).subarray(0, 8192 + 4 + chest.length);
  fs.writeFileSync(file, unpadded);
  assert.deepEqual(scanRegion(file, () => true, () => undefined).finds.map((f) => [f.item, f.count]), [['banksystem:money100', 4]]);
  fs.writeFileSync(file, unpadded.subarray(0, unpadded.length - 1));
  assert.equal(scanRegion(file, () => true, () => undefined).damaged, 1);
  fs.writeFileSync(file, nbtFile({}, false)); // not a region file at all, 4 bytes
  assert.throws(() => readRegion(file, () => {}));
});

test('the import does not scan; the coverage says "not run" with the files on disk', () => {
  open(fx.master, ...fx.slaves);
  const s = api.scanStatus();
  assert.equal(s.running, false);
  assert.equal(s.state, 'not run');
  assert.deepEqual([s.files, s.filesTotal, s.notes], [0, SCAN.files, 0n]);
  assert.deepEqual(s.saves.map((x) => [x.save, x.state]), [['survival-main', 'not run'], ['mining-1', 'no region files'], ['nether-hub', 'no region files']]);
  const w = api.worldItems();
  assert.deepEqual([w.notes, w.blocks, w.places, w.scan.state], [WORLD.found, 0n, [], 'not run']);
});

test('the scan: every dimension in the background, progress per file, the finds by place in worldItems', async () => {
  open(fx.master, ...fx.slaves);
  const started = api.startScan();
  assert.equal(started.running, true);
  assert.equal(api.startScan().running, true); // a second start while it runs does nothing
  await until(() => !api.scanStatus().running);
  const s = api.scanStatus();
  assert.equal(s.state, 'complete');
  assert.deepEqual([s.files, s.filesTotal, s.chunks, s.notes, s.dropped], [SCAN.files, SCAN.files, SCAN.chunks.read, SCAN.blocks, 0]);
  assert.deepEqual(s.unreadable, { files: 0, damaged: SCAN.chunks.damaged, lz4: SCAN.chunks.lz4, tooLarge: 0 });
  assert.equal(s.bytes, s.bytesTotal);
  // One event per file, then one when it ends; each carries the status for a bar.
  const scans = events.filter((e) => e.scan);
  assert.equal(scans.length, SCAN.files + 1);
  assert.deepEqual(scans.map((e) => e.done), [1, 2, 3, 4, 5, 5]);
  assert.ok(scans.every((e) => e.total === SCAN.files));
  assert.equal(scans.at(-1)!.scan!.running, false);

  const w = api.worldItems();
  assert.equal(w.blocks, SCAN.blocks);
  assert.equal(w.offers, SCAN.offers);
  assert.equal(w.notes, WORLD.found + SCAN.blocks);
  assert.deepEqual(w.altered, { stacks: 2, count: 2 }); // Quenby's renamed note, and the one in the chest
  assert.equal(w.placesCut, 0);
  const place = (where: string) => w.places.find((p) => p.where === where)!;
  const chest = place("chest at the overworld, -884 28 -1'024");
  assert.equal(chest.notes, 2_000_000n);
  assert.deepEqual(chest.valuables.map((v) => [v.item, v.itemId, v.count]), [['minecraft:diamond', ITEM.diamond, 64]]);
  assert.deepEqual(place("barrel at the overworld, -880 64 -1'020").stacks.map((x) => [x.path, x.item, x.count, x.value]), [[['minecraft:shulker_box'], 'banksystem:money100', 50, 500_000n]]);
  assert.equal(place("money stockpile at the overworld, -878 64 -1'018").notes, 350_000n);
  assert.deepEqual(place("bank terminal at the overworld, -876 64 -1'018").player, { uuid: uuidText(PLAYERS.Quenby.n), name: 'Quenby' });
  assert.equal(place("bank upload at the overworld, -875 64 -1'018").account, PLAYERS.Mikko_82.account);
  assert.equal(place("chest at the Nether, 10 70 20").notes, 100_000n);
  assert.equal(place("dropped item at the overworld, -871 63 -1'016").notes, 100_000n);
  assert.equal(place("offers of a villager at the overworld, -881 64 -1'011").notes, SCAN.offers);
  assert.deepEqual(place('barrel at vaultmod:deep_vault, 5 30 5').valuables.map((v) => [v.item, v.count]), [['minecraft:diamond', 1024]]);
  assert.equal(w.places[0]!.where, "chest at the overworld, -884 28 -1'024"); // most notes first
});

test('stop keeps what is done; continue reads only the files not done; a changed file is read again', async () => {
  // Stop as soon as the first file is in.
  init(path.join(fx.root, `workspace-${++n}`), (p) => { if (p.scan?.running) api.stopScan(); });
  addSave(fx.master);
  api.startScan();
  await until(() => !api.scanStatus().running);
  const stopped = api.scanStatus();
  assert.equal(stopped.state, 'partial');
  assert.ok(stopped.files >= 1 && stopped.files < SCAN.files, String(stopped.files));
  assert.equal(api.worldItems().scan.files, stopped.files);
  // Continue: only the rest.
  let read = 0;
  init(path.join(fx.root, `workspace-${n}`), (p) => { if (p.scan?.running) read++; });
  addSave(fx.master);
  assert.equal(api.scanStatus().files, stopped.files); // kept in the cache across sessions
  await scanned();
  assert.equal(read, SCAN.files - stopped.files);
  assert.equal(api.scanStatus().state, 'complete');
  assert.equal(api.scanStatus().notes, SCAN.blocks);
  // A file that changed on disk counts as not done and is read again, alone.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(fx.master, 'DIM-1', 'region', 'r.0.0.mca'), later, later);
  init(path.join(fx.root, `workspace-${n}`), (p) => { if (p.scan?.running) read++; });
  addSave(fx.master);
  const changed = api.scanStatus();
  assert.deepEqual([changed.state, changed.files, changed.notes], ['partial', SCAN.files - 1, SCAN.blocks - 100_000n]);
  read = 0;
  await scanned();
  assert.equal(read, 1);
  assert.equal(api.scanStatus().notes, SCAN.blocks);
  // Stopped at once: nothing breaks, nothing is half written.
  api.removeSave(fx.master);
  addSave(fx.master);
  api.startScan();
  assert.equal(api.stopScan().running, false);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(api.scanStatus().files <= SCAN.files);
});

test('a save that is removed or read in again drops its scan', async () => {
  open(fx.master);
  await scanned();
  assert.equal(api.scanStatus().state, 'complete');
  removeSave(fx.master);
  addSave(fx.master);
  assert.equal(api.scanStatus().state, 'not run');
  await scanned();
  // A changed level.dat makes the import run again, which rebuilds the cache.
  const level = path.join(fx.master, 'level.dat'), later = new Date(Date.now() + 120_000);
  fs.utimesSync(level, later, later);
  addSave(fx.master);
  assert.equal(api.scanStatus().state, 'not run');
});

test('the banknote rule follows the coverage: complete, partial, and money that could be notes paid back through the converter', async () => {
  open(fx.master, ...fx.slaves);
  const count = api.banknotes(ALL).outstanding;
  const rule = () => api.findings(ALL, DEFAULT_RULES).findings.find((x) => x.rule === 'banknotes')!;
  assert.equal(rule().facts.scan, 'not run');
  await scanned();
  const f = rule(); // run again: the scan changed what is found
  assert.equal(f.facts.found, WORLD.found + SCAN.blocks);
  assert.equal(f.facts.blocks, SCAN.blocks);
  assert.equal(f.facts.offers, SCAN.offers);
  assert.equal(f.measured.value, count - WORLD.found - SCAN.blocks);
  const w = words(f);
  assert.match(w.summary, /\$839'180\.00 was found\. Looked at: player files, ender chests and every region file \(chests and other blocks, dropped items and other entities\)\. 3 chunks could not be read \(1 packed with LZ4, which the tool does not read\); what they hold is not counted\./);
  assert.match(w.summary, /Villagers' offers name \$320\.00 in notes; those are prices, not notes, and are not counted\./);
  assert.doesNotMatch(w.summary, /ATM converter/); // nothing appeared without a log row on this save
  assert.deepEqual(w.facts.find(([k]) => k === 'Found in blocks and entities'), ['Found in blocks and entities', "$32'940.00"]);
  const partial = words({ ...f, facts: { ...f.facts, scan: 'partial', scanFiles: 2, chunksUnread: 0, lz4: 0, filesUnread: 1 } });
  assert.match(partial.summary, /Looked at: player files, ender chests and 2 of 5 region files; the region scan was stopped or the world changed since, so notes in the rest of the world are not counted\. 1 region file not at all; what they hold is not counted\./);
  const short = f.measured.value as bigint;
  assert.match(words({ ...f, facts: { ...f.facts, appeared: 5_000_000n } }).summary,
    /Of the \$141'782\.00 not found, up to \$50'000\.00 may have been paid back through the ATM converter: that much appeared on accounts without a log row\./);
  assert.match(words({ ...f, facts: { ...f.facts, appeared: short + 1n } }).summary, /not found, all may have been paid back through the ATM converter/);
});

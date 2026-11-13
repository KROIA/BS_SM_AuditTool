// Opening a .zip: an Explorer zip of an export, a zip of a network, zip64, and every way a zip can try to
// get out of its folder, blow up or be broken. The zips are written by test/fixtures/zip.ts.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { CP437, unzip, ZIP_LIMITS } from '../../src/engine/save/zip.ts';
import { addSave, addZip, init, removeSave, workspace } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Progress } from '../../src/shared/api.ts';
import { buildFixtures, type Fixtures } from '../fixtures/build.ts';
import { folderEntries, writeZip, type ZipEntry } from '../fixtures/zip.ts';

let fx: Fixtures;
let n = 0;
const events: Progress[] = [];
const fresh = () => {
  const dir = path.join(fx.root, `workspace-${++n}`);
  events.length = 0;
  init(dir, (p) => events.push(p));
  return dir;
};
const ALL = { from: null, to: null, server: null };
/** What the findings say, without anything that could depend on where the save was read from. */
const findings = () => api.findings(ALL, DEFAULT_RULES).findings.map((f) => `${f.id} ${f.level} ${String(f.measured.value)}`).sort();
const zips = (name: string) => path.join(fx.root, 'zips-in', name);
const bytesOf = (s: string) => Buffer.from(s);
/** Unpacks into a new folder and returns the problems' sentences and the files written. */
async function unpackAll(entries: ZipEntry[], zip64 = false) {
  const file = writeZip(zips(`t${++n}.zip`), entries, zip64), dest = path.join(fx.root, `out-${n}`);
  const r = await unzip(file, dest);
  const files = fs.readdirSync(dest, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.relative(dest, path.join(d.parentPath, d.name)).replaceAll('\\', '/')).sort();
  return { texts: r.problems.map((p) => p.text), files, dest };
}

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-zip-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('an Explorer zip of an export package (one folder at the top) opens like the folder', async () => {
  fresh();
  addSave(fx.exported);
  const folder = { saves: workspace().saves.map((s) => [s.name, s.role, s.exported]), findings: findings() };
  fresh();
  const zip = writeZip(zips('export.zip'), folderEntries(fx.exported, path.basename(fx.exported) + '/'));
  const before = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), mtime = fs.statSync(zip).mtimeMs;
  const w = await addZip(zip);
  assert.deepEqual(w.saves.map((s) => [s.name, s.role, s.exported]), folder.saves);
  assert.equal(w.saves[0]!.path, path.join(zip, path.basename(fx.exported)));
  assert.deepEqual(findings(), folder.findings);
  assert.ok(events.some((e) => e.step.startsWith('Unpacking the zip: ') && e.save === 'export.zip' && e.total > 0));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), before, 'the zip is only read');
  assert.equal(fs.statSync(zip).mtimeMs, mtime);
});

test('a zip of the master and its slaves opens all three, with the same findings as the folders', async () => {
  fresh();
  for (const s of [fx.master, ...fx.slaves]) addSave(s);
  const folder = { names: workspace().saves.map((s) => s.name).sort(), warnings: workspace().warnings, findings: findings() };
  const dir = fresh();
  const zip = writeZip(zips('network.zip'), [fx.master, ...fx.slaves].flatMap((s) => folderEntries(s, `network/${path.basename(s)}/`)));
  const w = await addZip(zip);
  assert.deepEqual(w.saves.map((s) => s.name).sort(), folder.names);
  assert.deepEqual(w.warnings, folder.warnings);
  assert.deepEqual(w.saves.map((s) => s.path).sort(), [fx.master, ...fx.slaves].map((s) => path.join(zip, 'network', path.basename(s))).sort());
  assert.deepEqual(findings(), folder.findings);

  // Reopened: nothing is unpacked again, also after a restart; removing the last save of the zip removes the unpacked copy.
  const unpacked = path.join(dir, 'zips', fs.readdirSync(path.join(dir, 'zips'))[0]!);
  const stamp = fs.statSync(path.join(unpacked, 'unzip.json')).mtimeMs;
  events.length = 0;
  await addZip(zip);
  assert.equal(events.length, 0);
  init(dir, (p) => events.push(p));
  assert.deepEqual(workspace().saves.map((s) => s.name).sort(), folder.names);
  assert.equal(events.length, 0);
  assert.equal(fs.statSync(path.join(unpacked, 'unzip.json')).mtimeMs, stamp);
  for (const s of workspace().saves.slice(0, 2)) removeSave(s.path);
  assert.ok(fs.existsSync(unpacked), 'one save of the zip is still loaded');
  removeSave(workspace().saves[0]!.path);
  assert.equal(fs.existsSync(unpacked), false);
});

test('a zip64 zip of a world folder at the top opens; an unpacked copy deleted since is unpacked again by the window', async () => {
  fresh();
  addSave(fx.master);
  const folder = findings();
  const dir = fresh();
  const zip = writeZip(zips('survival-main.zip'), folderEntries(fx.master), true);
  const w = await addZip(zip);
  assert.deepEqual(w.saves.map((s) => [s.name, s.path]), [['survival-main', zip]]);
  assert.deepEqual(findings(), folder);
  init(dir);
  fs.rmSync(path.join(dir, 'zips'), { recursive: true });
  assert.deepEqual(workspace(), { saves: [], warnings: [], unpack: [zip] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')).saves, [zip], 'kept until it is opened again');
  assert.deepEqual((await addZip(zip)).saves.map((s) => s.name), ['survival-main']);
});

test('names that lead out of the folder, devices, streams and links are refused one by one; the rest unpacks', async () => {
  const r = await unpackAll([
    { name: '../x', data: bytesOf('a') }, { name: 'C:\\x', data: bytesOf('a') }, { name: '\\\\srv\\share\\x', data: bytesOf('a') },
    { name: 'a/../../x', data: bytesOf('a') }, { name: '/etc/x', data: bytesOf('a') }, { name: 'a/b:stream', data: bytesOf('a') },
    { name: 'dir/CON.txt', data: bytesOf('a') }, { name: 'nul', data: bytesOf('a') }, { name: 'x\0y', data: bytesOf('a') },
    { name: 'link', data: bytesOf('/etc/passwd'), link: true }, { name: '.. /x', data: bytesOf('a') }, { name: 'CONOUT$', data: bytesOf('a') },
    { name: 'ok/file.txt', data: bytesOf('kept') },
    { name: 'ok/', }, { name: '', raw: Buffer.from([0x6e, 0x81, 0x2e, 0x74]) },
  ]);
  assert.deepEqual(r.texts, [
    '"../x" was not unpacked: its name leads out of the folder.',
    '"C:\\x" was not unpacked: its name starts with a drive letter.',
    '"\\\\srv\\share\\x" was not unpacked: its name is a network path.',
    '"a/../../x" was not unpacked: its name leads out of the folder.',
    '"/etc/x" was not unpacked: its name is an absolute path.',
    '"a/b:stream" was not unpacked: its name holds a ":", which Windows reads as a hidden data stream.',
    '"dir/CON.txt" was not unpacked: its name uses "CON.txt", which Windows reserves for a device.',
    '"nul" was not unpacked: its name uses "nul", which Windows reserves for a device.',
    '"x?y" was not unpacked: its name holds a null character.',
    '"link" was not unpacked: it is a link, and links are skipped.',
    '".. /x" was not unpacked: a part of its name ends in a dot or a space, which Windows drops.',
    '"CONOUT$" was not unpacked: its name uses "CONOUT$", which Windows reserves for a device.',
  ]);
  assert.deepEqual(r.files, ['nü.t', 'ok/file.txt'], 'a name without the UTF-8 flag is read as code page 437');
  assert.equal(fs.readFileSync(path.join(r.dest, 'ok/file.txt'), 'utf8'), 'kept');
  assert.equal(fs.existsSync(path.join(fx.root, 'x')), false);
  assert.equal(CP437.length, 128);
});

test('encrypted entries, unknown methods and bad checksums are refused; nothing half-written stays', async () => {
  const r = await unpackAll([
    { name: 'secret.db', data: bytesOf('aaaa'), flags: 1 }, { name: 'ppmd.db', data: bytesOf('aaaa'), method: 12 },
    { name: 'bad.db', data: bytesOf('the data'), crc: 1234 }, { name: 'good.db', data: bytesOf('the data') },
  ]);
  assert.deepEqual(r.texts, [
    '"secret.db" was not unpacked: it is encrypted.',
    '"ppmd.db" was not unpacked: it is packed with a method the tool cannot read (12).',
    '"bad.db" was not unpacked: it is damaged (its checksum does not match).',
  ]);
  assert.deepEqual(r.files, ['good.db']);
});

test('bombs: an entry larger than declared, one past the ratio, the total cap and too many entries', async () => {
  const zeros = Buffer.alloc(1024 * 1024);
  const saved = { ...ZIP_LIMITS };
  try {
    let r = await unpackAll([{ name: 'small.db', data: zeros, size: 100 }]);
    assert.deepEqual(r.texts, ['"small.db" was not unpacked: it is damaged (it unpacks to more than the zip says).']);
    assert.deepEqual(r.files, []);
    ZIP_LIMITS.after = 64 * 1024;
    r = await unpackAll([{ name: 'zeros.db', data: zeros }]); // 1 MB of zeros packs to about 1 KB
    assert.deepEqual(r.texts, ['"zeros.db" was not unpacked: it unpacks to more than 200 times its packed size, like a zip bomb.']);
    Object.assign(ZIP_LIMITS, saved, { total: 1000 });
    await assert.rejects(unpackAll([{ name: 'a.db', data: Buffer.alloc(800, 1) }, { name: 'b.db', data: Buffer.alloc(800, 2) }]),
      { message: 'it unpacks to more than 1\'000 bytes, more than any save the tool knows (stopped at "b.db")' });
    Object.assign(ZIP_LIMITS, saved, { entries: 5 });
    await assert.rejects(unpackAll(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: bytesOf('x') }))),
      { message: 'it lists 6 files, more than the 5 the tool unpacks' });
  } finally {
    Object.assign(ZIP_LIMITS, saved);
  }
});

test('a zip cut off in the middle loads what is readable and lists the rest', async () => {
  const filler = crypto.randomBytes(256 * 1024); // does not compress: the cut lands inside it
  const zip = writeZip(zips('cut.zip'), [...folderEntries(fx.master, 'survival-main/'), { name: 'survival-main/zz-filler.bin', data: filler }, { name: 'survival-main/zz-after.txt', data: bytesOf('after') }]);
  const size = fs.statSync(zip).size;
  fs.truncateSync(zip, size - 128 * 1024);
  fresh();
  const w = await addZip(zip);
  assert.deepEqual(w.saves.map((s) => s.name), ['survival-main']);
  assert.match(w.saves[0]!.warnings[0]!, /^"survival-main\/zz-filler\.bin" was not unpacked: it is damaged or cut off/);
  assert.equal(w.saves[0]!.warnings.some((x) => x.includes('zz-after')), false, 'the walk stops where the data ends');
  fresh();
  addSave(fx.master);
  const folder = findings();
  fresh();
  await addZip(zip);
  assert.deepEqual(findings(), folder);
});

test('a zip with nothing the tool knows, and a file that is not a zip, each give one sentence', async () => {
  fresh();
  const zip = writeZip(zips('photos.zip'), [{ name: 'holiday/readme.txt', data: bytesOf('hello') }]);
  await assert.rejects(addZip(zip), { message: '"photos.zip" holds no BankSystem or StockMarket data. A zip should hold a world folder, its "data" folder or an audit export.' });
  const fake = path.join(fx.root, 'zips-in', 'fake.zip');
  fs.writeFileSync(fake, 'not a zip at all');
  await assert.rejects(addZip(fake), { message: '"fake.zip" could not be opened: it is not a zip, or it is empty.' });
  assert.deepEqual(workspace().saves, []);
  assert.deepEqual(fs.readdirSync(path.join(fx.root, `workspace-${n}`, 'zips')), [], 'nothing is left behind');
});

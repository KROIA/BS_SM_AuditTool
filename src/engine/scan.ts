// The region scan: on request only, in the background. A pool of worker threads reads the region files of
// the loaded saves, one file per task (save/region.ts), and the finds go into each save's cache. Stop keeps the files done;
// starting again continues with the rest, and a file whose size or time changed since is read again. A save that is removed
// or read in again drops its scan with its cache file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SaveSummary, ScanCoverage, ScanStatus } from '../shared/api.ts';
import { marketItems, moneyItems } from './query/check.ts';
import { all, num, text } from './query/db.ts';
import { findDataDir } from './save/locate.ts';
import { worthOf } from './save/players.ts';
import type { ScanAnswer } from './save/region-worker.ts';
import { cacheFile, folderOf, loadedSaves, mainData, saveData, tell } from './workspace.ts';

export const SCAN_LIMITS = {
  /** Region files per save; the rest are not listed. */
  files: 100_000,
  /** Finds kept per save (rows of the cache); notes are kept before valuables, the rest are counted as dropped. */
  rows: 200_000,
  /** Memory of one worker: a chunk unpacks to at most 64 MB, its NBT as objects takes several times that. */
  workerMb: 1024,
};

interface RegionFile { file: string; rel: string; dimension: string; size: number; mtime: number }
interface Task extends RegionFile { save: SaveSummary; cache: string }

const DIMENSIONS: [string, string][] = [['minecraft:overworld', ''], ['minecraft:the_nether', 'DIM-1'], ['minecraft:the_end', 'DIM1']];
const REGION = /^r\.-?\d{1,7}\.-?\d{1,7}\.mca$/;
const WORKER = new URL('./save/region-worker' + path.extname(fileURLToPath(import.meta.url)), import.meta.url); // .ts in tests, .js built

const dirs = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };

/** The region and entity files of every dimension of a save's world; none for an audit export. Listed once, again when a scan starts. */
const listed = new Map<string, RegionFile[]>();
function regionFiles(s: SaveSummary, fresh = false): RegionFile[] {
  const had = listed.get(s.path);
  if (had && !fresh) return had;
  const out: RegionFile[] = [];
  let world: string | null = null;
  try {
    const dataDir = findDataDir(folderOf(s.path));
    if (path.basename(dataDir) === 'data') world = path.dirname(dataDir);
  } catch {
    // the folder is gone
  }
  const dims = [...DIMENSIONS, ...dirs(path.join(world ?? '', 'dimensions')).flatMap((ns) =>
    dirs(path.join(world!, 'dimensions', ns)).map((name): [string, string] => [`${ns}:${name}`, path.join('dimensions', ns, name)]))];
  for (const [dimension, dir] of world ? dims : []) {
    for (const kind of ['region', 'entities']) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(world!, dir, kind)).filter((n) => REGION.test(n)).sort();
      } catch {
        continue; // no such folder
      }
      for (const n of names.slice(0, SCAN_LIMITS.files - out.length)) {
        const file = path.join(world!, dir, kind, n), st = fs.statSync(file, { throwIfNoEntry: false });
        if (st?.isFile()) out.push({ file, rel: path.join(dir, kind, n).replaceAll('\\', '/'), dimension, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
    }
  }
  listed.set(s.path, out);
  return out;
}

/** The files of a save the scan read at their current size and time, with what it counted. */
function doneFiles(s: SaveSummary) {
  const done = new Map(all(saveData(s), 'SELECT * FROM scan_file').map((r) => [String(r.file), r]));
  return regionFiles(s).flatMap((f) => {
    const r = done.get(f.rel);
    return r && num(r.size) === f.size && num(r.mtime) === f.mtime ? [{ ...f, row: r }] : [];
  });
}

const blank = (): ScanCoverage => ({ state: 'no region files', files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0, chunks: 0, unreadable: { files: 0, damaged: 0, lz4: 0, tooLarge: 0 }, dropped: 0 });
const stateOf = (c: ScanCoverage): ScanCoverage['state'] =>
  c.filesTotal === 0 ? 'no region files' : c.files === 0 ? 'not run' : c.files === c.filesTotal ? 'complete' : 'partial';

/** A save's coverage, the relative paths of its files done, and the notes found in them. */
export function coverage(s: SaveSummary): { coverage: ScanCoverage; done: Set<string>; notes: bigint } {
  const c = blank(), files = regionFiles(s), done = doneFiles(s);
  let notes = 0n;
  c.filesTotal = files.length;
  c.bytesTotal = files.reduce((a, f) => a + f.size, 0);
  for (const { size, row } of done) {
    c.files++;
    c.bytes += size;
    c.chunks += num(row.chunks)!;
    if (text(row.error) !== null) c.unreadable.files++;
    c.unreadable.damaged += num(row.damaged)!;
    c.unreadable.lz4 += num(row.lz4)!;
    c.unreadable.tooLarge += num(row.too_large)!;
    c.dropped += num(row.dropped)!;
    notes += BigInt(String(row.notes));
  }
  c.state = stateOf(c);
  return { coverage: c, done: new Set(done.map((f) => f.rel)), notes };
}

// ---- The job

interface Job {
  queue: Task[]; workers: Set<Worker>; busy: Map<Worker, Task>; caches: Set<string>; names: [number, string][]; valuables: string[];
  /** Answers not written yet, the timer that writes them, and when the last write was. */
  pending: [Task, ScanAnswer][]; timer: NodeJS.Timeout | null; wrote: number;
}
let job: Job | null = null;
let stamp = 0;
/**
 * Changes when a scan ends, is stopped or is dropped: the findings kept per settings are run again. Not per file, because
 * then every screen asking for findings during the scan would run the banknote rule again (AT-52: about 10 s); the screens
 * ask again when the scan ends anyway.
 */
export const scanStamp = () => stamp;

export function scanStatus(): ScanStatus {
  const out: ScanStatus = { ...blank(), running: job !== null, notes: 0n, saves: [] };
  for (const s of loadedSaves()) {
    const { coverage: c, notes } = coverage(s);
    out.saves.push({ save: s.name, ...c });
    out.notes += notes;
    for (const k of ['files', 'filesTotal', 'bytes', 'bytesTotal', 'chunks', 'dropped'] as const) out[k] += c[k];
    for (const k of ['files', 'damaged', 'lz4', 'tooLarge'] as const) out.unreadable[k] += c.unreadable[k];
  }
  out.state = stateOf(out);
  return out;
}

const progress = (save: string) => {
  const scan = scanStatus();
  tell({ save, step: scan.running ? 'Scanning the region files' : 'Region scan finished', done: scan.files, total: scan.filesTotal, scan });
};

/** Files' finds into one save's cache, each in place of what an earlier read of it left; one transaction. */
function write(cache: string, answers: [Task, ScanAnswer][]) {
  const db = new DatabaseSync(cache);
  try {
    db.exec('BEGIN');
    const clear = db.prepare('DELETE FROM scan_item WHERE file = ?'), count = db.prepare('SELECT count(*) AS n FROM scan_item');
    const insert = db.prepare(`INSERT INTO scan_item (file, dimension, x, y, z, place, source, owner, account, path, item, count, plain, worth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const file = db.prepare('INSERT OR REPLACE INTO scan_file VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [t, a] of answers) {
      clear.run(t.rel);
      let room = SCAN_LIMITS.rows - Number((count.get() as { n: number }).n);
      let dropped = 0, notes = 0n;
      // Money first, so that the row limit drops valuables before notes.
      for (const f of a.finds.sort((x, y) => Number(y.worth !== null) - Number(x.worth !== null))) {
        if (room-- <= 0) { dropped++; continue; }
        insert.run(t.rel, t.dimension, f.x, f.y, f.z, f.place, f.source, f.owner, f.account, JSON.stringify(f.path), f.item, f.count, +f.plain, f.worth);
        if (f.plain && f.worth !== null && f.source !== 'offer') notes += BigInt(f.count) * f.worth;
      }
      file.run(t.rel, t.dimension, t.size, t.mtime, a.chunks, a.damaged, a.lz4, a.tooLarge, a.error, dropped, String(notes));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/**
 * Writes the answers collected so far. A commit per file stalled the engine's thread for up to seconds now and then
 * (AT-52: flushing to disk), so a file is written at once only when the last write is a second ago, else with the next
 * write within that second. A file's finds and its scan_file row stay in one transaction, so "continue" stays right.
 */
const EVERY_MS = 1000;
function flush(j: Job) {
  if (j.timer) clearTimeout(j.timer);
  j.timer = null;
  j.wrote = Date.now();
  const by = new Map<string, [Task, ScanAnswer][]>();
  for (const p of j.pending) if (j.caches.has(p[0].cache)) (by.get(p[0].cache) ?? by.set(p[0].cache, []).get(p[0].cache)!).push(p);
  j.pending = [];
  for (const [cache, answers] of by) write(cache, answers);
}

function spawn(j: Job) {
  const w = new Worker(WORKER, { workerData: { names: j.names, valuables: j.valuables }, resourceLimits: { maxOldGenerationSizeMb: SCAN_LIMITS.workerMb } });
  j.workers.add(w);
  const done = (a: ScanAnswer) => {
    const t = j.busy.get(w)!;
    j.busy.delete(w);
    if (!j.caches.has(t.cache)) return; // the save was removed or read in again meanwhile
    j.pending.push([t, a]);
    const wait = EVERY_MS - (Date.now() - j.wrote);
    if (wait <= 0) {
      flush(j);
      progress(t.save.name);
    } else j.timer ??= setTimeout(() => { if (job === j) { flush(j); progress(t.save.name); } }, wait);
  };
  w.on('message', (a: ScanAnswer) => {
    if (job !== j) return; // stopped meanwhile
    done(a);
    next(j, w);
  });
  // The worker died on its file (out of memory): the file counts as not readable, and a new worker takes the next one.
  w.on('error', (e) => {
    if (job !== j || !j.busy.has(w)) return;
    j.workers.delete(w);
    done({ file: j.busy.get(w)!.file, error: e.message.slice(0, 200), chunks: 0, damaged: 0, lz4: 0, tooLarge: 0, finds: [] });
    next(j, spawn(j));
  });
  return w;
}

function next(j: Job, w: Worker) {
  if (job !== j) return; // stopped while the last answer was reported
  const t = j.queue.shift();
  if (!t) {
    j.workers.delete(w);
    void w.terminate();
    if (j.busy.size === 0) {
      flush(j);
      job = null;
      stamp++;
      progress('');
    }
    return;
  }
  j.busy.set(w, t);
  w.postMessage({ file: t.file });
}

export function startScan(save?: string): ScanStatus {
  if (job) return scanStatus();
  const targets = loadedSaves().filter((s) => save === undefined || cacheFile(s.path) === cacheFile(String(save)));
  const queue: Task[] = [];
  for (const s of targets) {
    regionFiles(s, true);
    const done = coverage(s).done;
    for (const f of regionFiles(s)) if (!done.has(f.rel)) queue.push({ ...f, save: s, cache: cacheFile(s.path) });
  }
  if (!queue.length) return scanStatus();
  // What to keep: notes (by name; the stockpile by the main save's item number) and items with a market on the main save.
  const db = mainData();
  const money = db ? moneyItems(db) : new Set<number>();
  const names = db ? all(db, 'SELECT id, name FROM item').flatMap((r): [number, string][] => (worthOf(String(r.name)) !== null ? [[num(r.id)!, String(r.name)]] : [])) : [];
  const markets = db ? marketItems(db) : new Set<number>();
  const valuables = db ? all(db, 'SELECT id, name FROM item WHERE plain = 1').filter((r) => markets.has(num(r.id)!) && !money.has(num(r.id)!)).map((r) => String(r.name)) : [];
  const j: Job = { queue, workers: new Set(), busy: new Map(), caches: new Set(targets.map((s) => cacheFile(s.path))), names, valuables, pending: [], timer: null, wrote: 0 };
  job = j;
  const count = Math.min(Math.max(1, os.availableParallelism() - 1), 4, queue.length);
  for (let i = 0; i < count; i++) next(j, spawn(j));
  return scanStatus();
}

/** Stops the workers; what they finished stays in the caches. */
export function stopScan(): ScanStatus {
  if (job) {
    flush(job);
    for (const w of job.workers) void w.terminate();
    job = null;
    stamp++;
  }
  return scanStatus();
}

/** Called before a save's cache is deleted or rebuilt: its part of a running scan ends, and the file lists are read again. */
export function dropScan(picked: string) {
  listed.clear();
  if (!job) return;
  const cache = cacheFile(picked);
  job.caches.delete(cache);
  job.queue = job.queue.filter((t) => t.cache !== cache);
  if (!job.caches.size) stopScan();
}

/** Ends any scan when the workspace changes; nothing is reported. */
export function resetScan() {
  if (job?.timer) clearTimeout(job.timer); // the answers not written yet are read again next time
  if (job) for (const w of job.workers) void w.terminate();
  job = null;
  listed.clear();
  stamp++;
}

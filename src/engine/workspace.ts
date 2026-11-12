// The engine's memory of what is loaded: the saves of one network, each read once into its own cache database.
// case.json remembers the save folders between sessions; the cache can be deleted at any time and is rebuilt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Progress, SaveSummary, Workspace } from '../shared/api.ts';
import { cachedSummary, importSave } from './save/import.ts';
import { findDataDir } from './save/locate.ts';

let root = ''; // the workspace folder: case.json and cache/
let saves: SaveSummary[] = [];
let report: (p: Progress) => void = () => {};
let masterDb: DatabaseSync | null = null;

const caseFile = () => path.join(root, 'case.json');
const cacheFile = (picked: string) => path.join(root, 'cache', crypto.createHash('sha1').update(path.resolve(picked).toLowerCase()).digest('hex').slice(0, 16) + '.db');
const hasBankOrMarket = (s: SaveSummary) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none' && x.status !== 'missing');
/** The same folder, however it was spelled. Compared through the cache file, which is what two spellings would share. */
const isSame = (s: SaveSummary, picked: string) => cacheFile(s.path) === cacheFile(picked);
/** The save that holds the bank and market data: the master, or a single server. */
const mainSave = () => saves.find(hasBankOrMarket);

function remember() {
  fs.writeFileSync(caseFile(), JSON.stringify({ version: 1, saves: saves.map((s) => s.path) }, null, 2));
}

function load(picked: string): SaveSummary {
  const cache = cacheFile(picked);
  return cachedSummary(cache, picked) ?? importSave(picked, cache, (step, done, total) => report({ save: path.basename(picked), step, done, total }));
}

function closeMaster() {
  masterDb?.close();
  masterDb = null;
}

/** What is odd about how the loaded saves fit together (DESIGN_SPEC section 4.3). */
function networkWarnings(): string[] {
  const out: string[] = [];
  const main = mainSave();
  const byUid = new Map<string, string>();
  for (const s of saves) {
    if (!s.serverUid) continue;
    const other = byUid.get(s.serverUid);
    if (other) out.push(`"${other}" and "${s.name}" have the same server id. One of them is a copy of the other world.`);
    byUid.set(s.serverUid, s.name);
  }
  for (const s of saves) {
    if (s.role !== 'SLAVE') continue;
    if (!main) out.push(`"${s.name}" is a slave, and its master is not loaded. Bank and market data are missing.`);
    else if (s.masterUid && main.serverUid && s.masterUid !== main.serverUid) out.push(`"${s.name}" belongs to another master than "${main.name}".`);
  }
  const played = saves.flatMap((s) => (s.lastPlayedMs ? [s.lastPlayedMs] : []));
  if (played.length > 1 && Math.max(...played) - Math.min(...played) > 3_600_000) {
    out.push('The copies were taken more than an hour apart. What happened in between can only be checked on the newer ones.');
  }
  return out;
}
const state = (): Workspace => ({ saves, warnings: networkWarnings() });

/** Sets where the workspace lives and who hears about progress. Called once, before anything else. */
export function init(dir: string, onProgress: (p: Progress) => void = () => {}) {
  closeMaster();
  root = dir;
  report = onProgress;
  saves = [];
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
}

/** The saves of the last session. A save whose folder is gone or unreadable is dropped from the list. */
export function workspace(): Workspace {
  if (saves.length === 0) {
    let paths: unknown = [];
    try {
      paths = (JSON.parse(fs.readFileSync(caseFile(), 'utf8')) as { saves?: unknown }).saves;
    } catch {
      // no case yet
    }
    for (const p of Array.isArray(paths) ? paths : []) {
      if (typeof p !== 'string') continue;
      try {
        saves.push(load(p));
      } catch {
        // the folder was moved or deleted since
      }
    }
  }
  return state();
}

export function addSave(chosen: string): Workspace {
  // The world folder, whether the world or its data folder was picked: both are the same save.
  const dir = path.resolve(findDataDir(chosen));
  const picked = path.basename(dir) === 'data' ? path.dirname(dir) : dir;
  closeMaster(); // a re-import replaces the cache file, which cannot be deleted while it is open (Windows)
  const summary = load(picked);
  const main = mainSave();
  if (main && !isSame(main, picked) && hasBankOrMarket(summary)) {
    fs.rmSync(cacheFile(picked), { force: true });
    throw new Error(`"${main.name}" is already loaded as the server with the bank and market data. One workspace holds one network: remove it first to look at "${summary.name}".`);
  }
  saves = [...saves.filter((s) => !isSame(s, picked)), summary];
  remember();
  return state();
}

export function removeSave(picked: string): Workspace {
  closeMaster();
  saves = saves.filter((s) => !isSame(s, picked));
  fs.rmSync(cacheFile(picked), { force: true });
  remember();
  return state();
}

/** The cache database of the save with the bank and market data, opened read-only; null when none is loaded. */
export function mainData(): DatabaseSync | null {
  const main = mainSave();
  if (!main) return null;
  masterDb ??= new DatabaseSync(cacheFile(main.path), { readOnly: true });
  return masterDb;
}

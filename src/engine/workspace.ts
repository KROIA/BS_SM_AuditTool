// The engine's memory of what is loaded: the saves of one network, each read once into its own cache database.
// case.json remembers the save folders between sessions; the cache can be deleted at any time and is rebuilt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_RULES, type CaseData, type Mark, type Progress, type RuleSettings, type SaveSummary, type Workspace } from '../shared/api.ts';
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
export const mainSave = () => saves.find(hasBankOrMarket);

// ---- case.json: the save folders, the rule settings and the marks on findings (DESIGN_SPEC 4.5)

/** case.json is small; anything above this was not written by the tool. */
export const CASE_LIMIT = 8 * 1024 * 1024;
const MARKS = 10_000, TEXT = 10_000;
interface Case { saves: string[]; rules: RuleSettings; marks: Record<string, Mark> }
let kase: Case | null = null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A threshold like its default: a boolean, a positive number, or a whole number kept as decimal text (raw money and items). */
function threshold(def: unknown, v: unknown): unknown {
  if (typeof def === 'boolean') return typeof v === 'boolean' ? v : def;
  if (typeof def === 'number') return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1e12 ? v : def;
  return typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : def;
}
function readRules(v: unknown): RuleSettings {
  const stored = isObject(v) ? v : {};
  return Object.fromEntries(Object.entries(DEFAULT_RULES).map(([rule, def]) => {
    const s = isObject(stored[rule]) ? stored[rule] : {};
    return [rule, Object.fromEntries(Object.entries(def).map(([k, d]) => [k, threshold(d, s[k])]))];
  })) as unknown as RuleSettings;
}
const str = (v: unknown, max = TEXT) => (typeof v === 'string' ? v.slice(0, max) : '');
function readMarks(v: unknown): Record<string, Mark> {
  const out: Record<string, Mark> = {};
  for (const [id, m] of Object.entries(isObject(v) ? v : {}).slice(0, MARKS)) {
    if (id.length > 500 || id === '__proto__' || !isObject(m)) continue;
    const mark: Mark = { title: str(m.title, 500), start: typeof m.start === 'number' && Number.isFinite(m.start) ? m.start : 0,
      pinned: m.pinned === true, dismissed: m.dismissed === true, reason: str(m.reason), note: str(m.note) };
    if (kept(mark)) out[id] = mark;
  }
  return out;
}
const kept = (m: Mark) => m.pinned || m.dismissed || m.note.trim() !== '';

/** Read once per workspace. A file that is too large or not JSON is kept as case.json.broken and the case starts empty. */
function theCase(): Case {
  if (kase) return kase;
  let raw: unknown = {};
  try {
    if (fs.statSync(caseFile()).size > CASE_LIMIT) throw new Error('too large');
    raw = JSON.parse(fs.readFileSync(caseFile(), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') fs.copyFileSync(caseFile(), caseFile() + '.broken');
  }
  const c = isObject(raw) ? raw : {};
  return (kase = { saves: Array.isArray(c.saves) ? c.saves.filter((p): p is string => typeof p === 'string').slice(0, 100) : [], rules: readRules(c.rules), marks: readMarks(c.marks) });
}

/** Written to a temporary file first and then renamed, so a crash never leaves half a case.json. */
function remember() {
  const c = theCase();
  c.saves = saves.map((s) => s.path);
  const text = JSON.stringify({ version: 2, ...c }, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v), 2);
  fs.writeFileSync(caseFile() + '.tmp', text);
  fs.renameSync(caseFile() + '.tmp', caseFile());
}

export const caseData = (): CaseData => ({ rules: theCase().rules, marks: theCase().marks });
export function mark(id: string, m: Mark): CaseData {
  const marks = theCase().marks;
  const clean = readMarks({ [String(id)]: m })[String(id)];
  if (clean) marks[String(id)] = clean;
  else delete marks[String(id)];
  remember();
  return caseData();
}
export function setRules(rules: RuleSettings): CaseData {
  theCase().rules = readRules(JSON.parse(JSON.stringify(rules, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))));
  remember();
  return caseData();
}
/** Ids of the findings marked as not a problem. */
export const dismissedIds = () => new Set(Object.entries(theCase().marks).flatMap(([id, m]) => (m.dismissed ? [id] : [])));

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
  kase = null;
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
}

/** The saves of the last session. A save whose folder is gone or unreadable is dropped from the list. */
export function workspace(): Workspace {
  if (saves.length === 0) {
    for (const p of theCase().saves) {
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

/** The name of the save with the bank and market data: where an order without a slave name was placed. */
export const mainName = (): string | null => mainSave()?.name ?? null;

/** The cache database of the save with the bank and market data, opened read-only; null when none is loaded. */
export function mainData(): DatabaseSync | null {
  const main = mainSave();
  if (!main) return null;
  masterDb ??= new DatabaseSync(cacheFile(main.path), { readOnly: true });
  return masterDb;
}

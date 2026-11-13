// The engine's memory of what is loaded: the saves of one network, each read once into its own cache database.
// case.json remembers the save folders between sessions; the cache can be deleted at any time and is rebuilt.
// A zip is unpacked into zips/ once and then opens like a folder; the save keeps the zip's path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bytes } from '../shared/fmt.ts';
import { DEFAULT_RULES, type Answer, type CaseChoices, type CaseData, type Cutoff, type Mark, type Progress, type RuleSettings, type SaveSummary, type Workspace } from '../shared/api.ts';
import { cachedSummary, importSave } from './save/import.ts';
import { findDataDir } from './save/locate.ts';
import { unzip, type ZipProblem } from './save/zip.ts';
import { dropScan, resetScan } from './scan.ts';

let root = ''; // the workspace folder: case.json and cache/
let saves: SaveSummary[] = [];
/**
 * Saves opened from a zip: the path the save goes by (the zip's, with the folder inside for a zip of several saves) ->
 * the zip, the unpacked folder and what was not unpacked from that part. waiting: saves from zips of the last session
 * whose unpacked copy is gone; the window opens those zips again (Workspace.unpack), until then case.json keeps them.
 */
const fromZip = new Map<string, { zip: string; dir: string; problems: string[] }>();
let waiting: string[] = [];
/** The folder a save is read from: the unpacked copy for a save from a zip. */
export const folderOf = (picked: string) => fromZip.get(picked)?.dir ?? picked;
let report: (p: Progress) => void = () => {};
/** Sends progress to whoever listens (the window); the region scan reports through it too. */
export const tell = (p: Progress) => report(p);
/** The cache databases opened read-only, by cache file. Closed whenever the loaded saves change. */
const opened = new Map<string, DatabaseSync>();

const caseFile = () => path.join(root, 'case.json');
/** The cache database of a save folder, however it was spelled. */
export const cacheFile = (picked: string) => path.join(root, 'cache', crypto.createHash('sha1').update(path.resolve(picked).toLowerCase()).digest('hex').slice(0, 16) + '.db');
const hasBankOrMarket = (s: SaveSummary) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none' && x.status !== 'missing');
/** The same folder, however it was spelled. Compared through the cache file, which is what two spellings would share. */
const isSame = (s: SaveSummary, picked: string) => cacheFile(s.path) === cacheFile(picked);
/** The save that holds the bank and market data: the master, or a single server. */
export const mainSave = () => saves.find(hasBankOrMarket);

// ---- case.json: the save folders, the rule settings and the marks on findings

/** case.json is small; anything above this was not written by the tool. */
export const CASE_LIMIT = 8 * 1024 * 1024;
const MARKS = 10_000, TEXT = 10_000;
interface Case { saves: string[]; rules: RuleSettings; marks: Record<string, Mark>; choices: CaseChoices }
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
const CUTS: Cutoff['kind'][] = ['day', 'first', 'custom'], ANSWERS: Answer[] = ['yes', 'unsure', 'no'];
/** The Case screen's choices; anything unknown falls back to the recommended cutoff, no answers and the pins' own order. */
function readChoices(v: unknown): CaseChoices {
  const c = isObject(v) ? v : {}, cut = isObject(c.cutoff) ? c.cutoff : {};
  const answers: Record<string, Answer> = {};
  for (const [k, a] of Object.entries(isObject(c.answers) ? c.answers : {}).slice(0, MARKS)) {
    if (k.length <= 200 && k !== '__proto__' && ANSWERS.includes(a as Answer)) answers[k] = a as Answer;
  }
  return {
    cutoff: { kind: CUTS.includes(cut.kind as Cutoff['kind']) ? cut.kind as Cutoff['kind'] : 'day', at: typeof cut.at === 'number' && Number.isFinite(cut.at) ? cut.at : null },
    answers,
    order: Array.isArray(c.order) ? c.order.filter((id): id is string => typeof id === 'string' && id.length <= 500).slice(0, MARKS) : [],
    style: c.style === 'tech' ? 'tech' : 'admin',
    lang: c.lang === 'de' ? 'de' : 'en',
  };
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
  return (kase = { saves: Array.isArray(c.saves) ? c.saves.filter((p): p is string => typeof p === 'string').slice(0, 100) : [], rules: readRules(c.rules), marks: readMarks(c.marks), choices: readChoices(c.choices) });
}

/** Written to a temporary file first and then renamed, so a crash never leaves half a case.json. */
function remember() {
  const c = theCase();
  c.saves = [...saves.map((s) => s.path), ...waiting];
  const text = JSON.stringify({ version: 2, ...c }, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v), 2);
  fs.writeFileSync(caseFile() + '.tmp', text);
  fs.renameSync(caseFile() + '.tmp', caseFile());
}

export const caseData = (): CaseData => ({ rules: theCase().rules, marks: theCase().marks, choices: theCase().choices });
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
export function setChoices(choices: CaseChoices): CaseData {
  theCase().choices = readChoices(choices);
  remember();
  return caseData();
}
/** Ids of the findings marked as not a problem. */
export const dismissedIds = () => new Set(Object.entries(theCase().marks).flatMap(([id, m]) => (m.dismissed ? [id] : [])));

function load(picked: string): SaveSummary {
  const cache = cacheFile(picked), dir = folderOf(picked), zip = fromZip.get(picked);
  let summary = cachedSummary(cache, dir);
  if (!summary) {
    dropScan(picked); // the cache is rebuilt, and the scan's results with it
    summary = importSave(dir, cache, (step, done, total) => report({ save: path.basename(picked), step, done, total }));
  }
  return zip ? { ...summary, path: picked, warnings: [...zip.problems, ...summary.warnings] } : summary;
}

// ---- zips: unpacked once per zip path, size and time; unzip.json beside the contents says it is complete

const zipHome = (zip: string) => path.join(root, 'zips', crypto.createHash('sha1').update(path.resolve(zip).toLowerCase()).digest('hex').slice(0, 16));
/** The folder the contents go into is named after the zip, so a save at the top of the zip is named like it. */
const zipContent = (zip: string) => path.join(zipHome(zip), path.parse(zip).name.replace(/[. ]+$/, '') || 'zip');
const isZip = (p: string) => /\.zip$/i.test(p) && (fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false);
/** The zip a remembered save path belongs to: the path itself, or the zip a folder inside it (up to three deep) goes by. */
const zipOf = (p: string) => [p, path.dirname(p), path.dirname(path.dirname(p)), path.dirname(path.dirname(path.dirname(p)))].find(isZip) ?? null;

interface Unpacked { size: number; mtime: number; problems: ZipProblem[] }
/** What a complete earlier unpack of this zip left out; null when there is none or the zip changed since. */
function unpacked(zip: string): ZipProblem[] | null {
  try {
    const st = fs.statSync(zip), m = JSON.parse(fs.readFileSync(path.join(zipHome(zip), 'unzip.json'), 'utf8')) as Unpacked;
    if (m.size !== st.size || m.mtime !== Math.round(st.mtimeMs) || !Array.isArray(m.problems)) return null;
    return m.problems.filter((x) => typeof x?.entry === 'string' && typeof x.text === 'string');
  } catch {
    return null;
  }
}

async function unpack(zip: string): Promise<ZipProblem[]> {
  const done = unpacked(zip);
  if (done) return done;
  const home = zipHome(zip), st = fs.statSync(zip);
  fs.rmSync(home, { recursive: true, force: true });
  try {
    const r = await unzip(zip, zipContent(zip), (d, t) => report({ save: path.basename(zip), step: `Unpacking the zip: ${bytes(d)} of ${bytes(t)}`, done: d, total: t }));
    const m: Unpacked = { size: st.size, mtime: Math.round(st.mtimeMs), problems: r.problems };
    fs.writeFileSync(path.join(home, 'unzip.json'), JSON.stringify(m)); // written last: without it the zip is unpacked again
    return r.problems;
  } catch (e) {
    fs.rmSync(home, { recursive: true, force: true });
    throw new Error(`"${path.basename(zip)}" could not be opened: ${(e as Error).message.replace(/\.$/, '')}.`);
  }
}

/** The save folders inside an unpacked zip, as the folder picker would take them: up to three folders deep, not inside a save. */
function savesIn(dir: string): string[] {
  const out: string[] = [];
  let level = [dir];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: string[] = [];
    for (const d of level) {
      try {
        const data = findDataDir(d);
        out.push(path.basename(data) === 'data' ? path.dirname(data) : data);
      } catch {
        try {
          next.push(...fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(d, x.name)).sort());
        } catch { /* unreadable */ }
      }
    }
    level = next.slice(0, 500);
  }
  return out;
}

/** Fills fromZip for the saves inside an unpacked zip; each problem goes to the save its entry lies in, else the first. */
function mapZip(zip: string, problems: ZipProblem[]): string[] {
  const content = zipContent(zip);
  const found = savesIn(content).map((dir) => ({ dir, rel: path.relative(content, dir).replaceAll(path.sep, '/'), problems: [] as string[] }));
  for (const p of problems) {
    const entry = p.entry.replaceAll('\\', '/');
    const own = found.filter((f) => entry.startsWith(f.rel + '/')).sort((a, b) => b.rel.length - a.rel.length)[0] ?? found[0];
    own?.problems.push(p.text);
  }
  return found.map((f) => {
    const picked = path.join(zip, f.rel);
    fromZip.set(picked, { zip, dir: f.dir, problems: f.problems });
    return picked;
  });
}

/** Opens a zip like a folder: unpacked (once), then every save inside is added. */
export async function addZip(file: string): Promise<Workspace> {
  const zip = path.resolve(file);
  const problems = await unpack(zip);
  waiting = waiting.filter((p) => zipOf(p) !== zip);
  const found = mapZip(zip, problems);
  if (!found.length) {
    if (!saves.some((s) => fromZip.get(s.path)?.zip === zip)) fs.rmSync(zipHome(zip), { recursive: true, force: true });
    const lost = problems.length ? ` ${problems.length === 1 ? 'One file was' : `${problems.length} files were`} not unpacked, for example: ${problems[0]!.text}` : '';
    throw new Error(`"${path.basename(zip)}" holds no BankSystem or StockMarket data. A zip should hold a world folder, its "data" folder or an audit export.${lost}`);
  }
  let w = state();
  for (const picked of found) w = add(picked);
  return w;
}

/** A folder, or a .zip file. */
export const open = (chosen: string): Workspace | Promise<Workspace> => (isZip(chosen) ? addZip(chosen) : addSave(chosen));

function closeMaster() {
  for (const db of opened.values()) db.close();
  opened.clear();
}

/** What is odd about how the loaded saves fit together. */
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
const state = (): Workspace => ({ saves, warnings: networkWarnings(), ...(waiting.length ? { unpack: [...new Set(waiting.map((p) => zipOf(p)!))] } : {}) });

/** Sets where the workspace lives and who hears about progress. Called once, before anything else. */
export function init(dir: string, onProgress: (p: Progress) => void = () => {}) {
  resetScan();
  closeMaster();
  root = dir;
  report = onProgress;
  saves = [];
  fromZip.clear();
  waiting = [];
  kase = null;
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
}

/** The saves of the last session. A save whose folder is gone or unreadable is dropped from the list. */
export function workspace(): Workspace {
  if (saves.length === 0) {
    for (const p of theCase().saves) {
      try {
        const zip = zipOf(p);
        if (zip && !fromZip.has(p)) {
          const problems = unpacked(zip);
          if (!problems) {
            waiting.push(p);
            continue;
          }
          mapZip(zip, problems);
        }
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
  return add(path.basename(dir) === 'data' ? path.dirname(dir) : dir);
}

/** Adds one save folder, or one save inside an unpacked zip by the path it goes by. */
function add(picked: string): Workspace {
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
  dropScan(picked);
  fs.rmSync(cacheFile(picked), { force: true });
  // The unpacked copy goes with the last save of its zip.
  const zip = [...fromZip].find(([p]) => cacheFile(p) === cacheFile(picked))?.[1].zip;
  waiting = waiting.filter((p) => cacheFile(p) !== cacheFile(picked));
  if (zip && !saves.some((s) => fromZip.get(s.path)?.zip === zip)) {
    for (const [p, z] of fromZip) if (z.zip === zip) fromZip.delete(p);
    try {
      fs.rmSync(zipHome(zip), { recursive: true, force: true, maxRetries: 3 });
    } catch { /* a file still open: the next unpack of this zip replaces it */ }
  }
  remember();
  return state();
}

/** The name of the save with the bank and market data: where an order without a slave name was placed. */
export const mainName = (): string | null => mainSave()?.name ?? null;

/** The cache database of the save with the bank and market data, opened read-only; null when none is loaded. */
export function mainData(): DatabaseSync | null {
  const main = mainSave();
  return main ? saveData(main) : null;
}

/** The loaded saves, in the order they were added. */
export const loadedSaves = (): readonly SaveSummary[] => saves;

/** The cache database of one loaded save, opened read-only (the slaves' transfer journals). */
export function saveData(s: SaveSummary): DatabaseSync {
  const file = cacheFile(s.path);
  let db = opened.get(file);
  if (!db) opened.set(file, (db = new DatabaseSync(file, { readOnly: true })));
  return db;
}

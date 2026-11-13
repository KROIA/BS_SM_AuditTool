// What the whole program shares: the open screen, the theme, the loaded saves and what is being loaded.
import { DEFAULT_RULES, type CaseChoices, type CaseData, type Incident, type Mark, type Progress, type RemoteEngine, type ReportOptions, type RuleSettings, type SaveSummary, type ScanStatus, type Scope, type Workspace } from '../../shared/api.ts';

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  pickFolder(zip?: boolean): Promise<string | null>;
  exportReport(incidentId: string, options: ReportOptions, settings: RuleSettings): Promise<{ path: string } | { error: string } | null>;
  saveText(defaultName: string, text: string, kind: 'csv'): Promise<{ path: string } | { error: string } | null>;
  startupPaths(): Promise<string[]>;
  onProgress(listener: (p: Progress) => void): void;
  pathOf(file: File): string;
}
const bridge = (window as unknown as { audit: Bridge }).audit;

/** The engine, called like a local object: engine.addSave(path). */
export const engine = new Proxy({}, { get: (_t, method: string) => (...args: unknown[]) => bridge.call(method, ...args) }) as RemoteEngine;

const routeFromHash = () => location.hash.slice(2) || 'saves';
function storedTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; // dark is the default
  } catch {
    return 'dark';
  }
}

export const app = $state({
  route: routeFromHash(),
  theme: storedTheme(),
  saves: [] as SaveSummary[],
  /** What is odd about how the saves fit together. */
  warnings: [] as string[],
  /** What went wrong with the saves opened last, in plain words. */
  errors: [] as string[],
  /** Folders opened and not read yet, in order. The first one is being read. */
  queue: [] as string[],
  /** The time range and server filter of the top bar. Every screen passes it to its questions. */
  scope: { from: null, to: null, server: null } as Scope,
  /** Which choice of the time range menu made scope.from and scope.to. */
  range: 'all' as Range,
  /** True while the engine reads a save; `loading` then says how far it is. */
  busy: false,
  loading: null as Progress | null,
  /** The rule settings and the marks on findings, from case.json. Pass rules on with $state.snapshot. */
  rules: DEFAULT_RULES as RuleSettings,
  marks: {} as Record<string, Mark>,
  /** The Case screen's cutoff, answers and evidence order, from case.json. */
  choices: { cutoff: { kind: 'day', at: null }, answers: {}, order: [], style: 'admin', lang: 'en' } as CaseChoices,
  /** "The incident" of the range menu and the Overview (ScopeMenus works it out); undefined while the rules run. */
  incident: undefined as Incident | null | undefined,
  /** How far the region scan got; kept here so the bar lives on while other screens are open. */
  scan: null as ScanStatus | null,
  /** Goes up when the scan's results change (a scan ended or was stopped): what shows them asks again. */
  scanRound: 0,
});

function useCase(c: CaseData) {
  app.rules = c.rules;
  app.marks = c.marks;
  app.choices = c.choices;
}
/** Stores what the user marked on a finding; a mark with nothing left in it is removed. */
export const setMark = async (id: string, m: Mark) => useCase(await engine.mark(id, $state.snapshot(m)));
export const setChoices = async (c: CaseChoices) => useCase(await engine.setChoices($state.snapshot(c)));
export const setRules = async (r: RuleSettings) => useCase(await engine.setRules($state.snapshot(r)));
/** Builds the report with the case's rules, asks where to save it and saves it (main.ts). null: the user cancelled. */
export const exportReport = (incidentId: string, options: ReportOptions) => bridge.exportReport(incidentId, options, $state.snapshot(app.rules));
/** Asks where to save a table made as CSV text and saves it (main.ts). null: the user cancelled. */
export const saveText = (defaultName: string, text: string) => bridge.saveText(defaultName, text, 'csv');
/** The number of pins, for the case counter. */
export const pins = () => Object.values(app.marks).filter((m) => m.pinned).length;

/** incident: the strongest incident's span, padded by 30 minutes on each side. */
export type Range = 'all' | 'day' | 'week' | 'incident' | 'custom';
const DAY = 86_400_000;

/** The newest time any table of the loaded saves reaches: "the last 24 hours" count back from here, not from today. */
export function newest(): number | null {
  const ends = app.saves.flatMap((s) => s.sources.flatMap((x) => x.tables.map((t) => t.to ?? 0)));
  return Math.max(0, ...ends) || null;
}

/** Sets the time range of the whole tool. from and to are only used for 'custom' and 'incident'. */
export function setRange(range: Range, from: number | null = null, to: number | null = null) {
  const end = newest();
  if ((range === 'day' || range === 'week') && end !== null) [from, to] = [end - (range === 'day' ? DAY : 7 * DAY), null];
  if (range === 'all') [from, to] = [null, null];
  app.range = range;
  app.scope = { ...app.scope, from, to };
}

addEventListener('hashchange', () => (app.route = routeFromHash()));
// The region scan reports on the import's channel (Progress.scan) and must not take over the import's bar.
bridge.onProgress((p) => {
  if (!p.scan) return void (app.loading = p);
  app.scan = p.scan;
  if (!p.scan.running) app.scanRound++;
});

/** Starts the region scan of every loaded save, or continues it; it runs in the engine's background. */
export async function startScan() {
  app.scan = await engine.startScan();
}
export async function stopScan() {
  app.scan = await engine.stopScan();
  app.scanRound++; // stopping sends no progress: what was done so far is the result now
}

export function toggleTheme() {
  app.theme = app.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', app.theme);
  } catch {
    // the choice then only lasts until the program closes
  }
}

/** Runs a call that returns the workspace, and shows its result or its error. */
async function run(call: () => Promise<Workspace>) {
  app.busy = true;
  try {
    const w = await call();
    app.saves = w.saves;
    app.warnings = w.warnings;
    app.scan = await engine.scanStatus(); // a save that came or went changes what there is to scan
    // Other saves move "the last 24 hours", and a server whose save is gone cannot be filtered for.
    if (app.range === 'day' || app.range === 'week') setRange(app.range);
    if (app.scope.server !== null && !app.saves.some((s) => s.name === app.scope.server)) app.scope = { ...app.scope, server: null };
  } catch (e) {
    // Electron wraps the engine's sentence in its own; show only the engine's.
    app.errors.push((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  } finally {
    app.busy = false;
    app.loading = null;
  }
}

/**
 * From the Saves screen to the Overview once saves are loaded. Not when something went wrong: the
 * Saves screen says what. The route is set at once, not on hashchange, so the Overview asks before the slow rules run.
 */
function toOverview() {
  if (app.route !== 'saves' || app.saves.length === 0 || app.errors.length) return;
  location.hash = '#/overview';
  app.route = 'overview';
}

/** Reads the folders one after the other. Folders opened while others are read join the end of the queue. */
export async function addSaves(paths: string[]) {
  const idle = app.queue.length === 0;
  if (idle) app.errors = [];
  app.queue.push(...paths);
  if (!idle) return;
  const first = app.saves.length === 0;
  while (app.queue.length) {
    await run(() => engine.addSave(app.queue[0]!));
    app.queue.shift();
  }
  if (first) toOverview();
}

export function removeSave(path: string) {
  app.errors = [];
  return run(() => engine.removeSave(path));
}

/** zip: a .zip file instead of a folder (one dialog cannot offer both on Windows). */
export async function browse(zip = false) {
  const path = await bridge.pickFolder(zip);
  if (path) await addSaves([path]);
}

/** Folders and zips dropped onto the page. Anything else is passed on too: the engine says what is wrong with it. */
export function drop(files: FileList) {
  const paths = [...files].map((f) => bridge.pathOf(f)).filter(Boolean);
  if (paths.length) void addSaves(paths);
}

/** The name a folder will have on its card: the world folder's, also when its data folder was picked. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return (parts.at(-1)?.toLowerCase() === 'data' && parts.length > 1 ? parts.at(-2) : parts.at(-1)) ?? path;
}

/** Brings back the saves of the last session, then opens the folders given on the command line. */
export async function start() {
  // The rules first: the Overview's questions follow the saves at once and should not run with the defaults.
  useCase(await engine.caseData());
  let unpack: string[] = [];
  await run(async () => {
    const w = await engine.workspace();
    unpack = w.unpack ?? []; // zips of the last session whose unpacked copy is gone
    return w;
  });
  toOverview();
  await addSaves([...unpack, ...(await bridge.startupPaths())]);
}

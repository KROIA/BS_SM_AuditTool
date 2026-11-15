// The window process. It opens the window, shows the folder dialog and passes calls on to the engine.
// It holds no logic of its own, and the screens get no file or system access (see preload.cts).
import { app, BrowserWindow, dialog, ipcMain, Menu, session, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Workspace } from '../shared/api.ts';

const here = import.meta.dirname; // dist/node/main
let win: BrowserWindow | null = null;
let engine: UtilityProcess;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function startEngine() {
  // The engine keeps its workspace (the list of saves and the cache) in the program's own data folder, never in a save.
  engine = utilityProcess.fork(path.join(here, '../engine/host.js'), [path.join(app.getPath('userData'), 'workspace')], { serviceName: 'Audit Tool engine' });
  engine.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string; progress?: unknown }) => {
    if (m.progress) return void win?.webContents.send('progress', m.progress);
    const call = waiting.get(m.id);
    if (!call) return;
    waiting.delete(m.id);
    if (m.ok) call.resolve(m.result);
    else call.reject(new Error(m.error));
  });
  engine.on('exit', (code) => {
    for (const call of waiting.values()) call.reject(new Error(`The engine stopped unexpectedly (code ${code}).`));
    waiting.clear();
  });
}

function callEngine(method: unknown, args: unknown): Promise<unknown> {
  if (typeof method !== 'string' || !Array.isArray(args)) return Promise.reject(new Error('Malformed engine call.'));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    engine.postMessage({ id, method, args });
  });
}

/** Folders given on the command line: audit-tool --open <folder> [--open <folder> ...]. Used by the screen tests. */
function startupPaths(): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    const next = process.argv[i + 1];
    if (a === '--open' && next) out.push(next);
  });
  return out;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e1013',
    title: 'Audit Tool',
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The tool is offline: the window never opens another page and never leaves its own.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // The screen tests show the window without taking the focus: keys a person types meanwhile stay in their own window
  // instead of landing in the test (an Enter on a focused menu button opens the menu the next step expects closed).
  win.once('ready-to-show', () => (process.env.AUDIT_TOOL_BACKGROUND ? win?.showInactive() : win?.show()));
  void win.loadFile(path.join(here, '../../ui/index.html'));
}

// The screen tests give the program a data folder of its own, so they never see a person's workspace.
if (process.env.AUDIT_TOOL_DATA) app.setPath('userData', path.resolve(process.env.AUDIT_TOOL_DATA));
Menu.setApplicationMenu(null);
ipcMain.handle('engine', (_e, method, args) => callEngine(method, args));
ipcMain.handle('startupPaths', () => startupPaths());
// Windows cannot pick a folder and a file in one dialog: zip asks for a .zip file instead of a folder.
// Each dialog starts where it was last used: in the last folder picked, or in the folder of the last zip (a new export gets a new name).
const lastPicked = () => path.join(app.getPath('userData'), 'last-picked.json');
ipcMain.handle('pickFolder', async (_e, zip: unknown) => {
  if (!win) return null;
  const kind = zip === true ? 'zip' : 'folder';
  let last: Record<string, unknown> = {};
  try {
    last = JSON.parse(await fs.readFile(lastPicked(), 'utf8'));
  } catch { /* first use, or the file was removed */ }
  const prev = last[kind], before = typeof prev === 'string' ? (kind === 'zip' ? path.dirname(prev) : prev) : undefined;
  const r = await dialog.showOpenDialog(win, kind === 'zip'
    ? { title: 'Open a zipped save', defaultPath: before, properties: ['openFile'], filters: [{ name: 'Zip (*.zip)', extensions: ['zip'] }] }
    : { title: 'Open a save', defaultPath: before, properties: ['openDirectory'] });
  const picked = r.canceled ? null : (r.filePaths[0] ?? null);
  if (picked) await fs.writeFile(lastPicked(), JSON.stringify({ ...last, [kind]: picked })).catch(() => {});
  return picked;
});

/** A path with links and junctions resolved; a file that does not exist yet by its folder. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const up = path.dirname(p);
    return up === p ? p : path.join(real(up), path.basename(p));
  }
}
/** True when target is the folder or inside it (Windows compares without case). */
const within = (folder: string, target: string) => {
  const rel = path.relative(real(folder), real(target));
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); // a folder named "..x" inside still counts
};

/**
 * The report as PDF: printed by a hidden window that runs no script, has no preload and a session of its own that refuses
 * every request but the report's own file, so nothing in the page can load or reach anything.
 */
async function pdf(html: string): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(app.getPath('temp'), 'audit-report-'));
  const file = path.join(dir, 'report.html');
  const page = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, session: session.fromPartition('report-print') } });
  try {
    await fs.writeFile(file, html);
    const allowed = pathToFileURL(file).href.toLowerCase();
    page.webContents.session.webRequest.onBeforeRequest((d, done) => done({ cancel: d.url.toLowerCase() !== allowed }));
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    page.webContents.on('will-navigate', (e) => e.preventDefault());
    await page.loadFile(file);
    return await page.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    page.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

type Saved = { path: string } | { error: string } | null;
/** Asks where to save, refuses a folder of a loaded save, then writes what content() makes for the chosen path. what: "report", "table". */
async function saveAs(what: string, defaultPath: string, filters: Electron.FileFilter[], content: (target: string) => Promise<string | Buffer>): Promise<Saved> {
  if (!win) return null;
  const r = await dialog.showSaveDialog(win, { title: `Export the ${what}`, defaultPath, filters });
  if (r.canceled || !r.filePath) return null;
  const target = path.resolve(r.filePath);
  // The tool never writes into a save, not even a report.
  const saves = ((await callEngine('workspace', [])) as Workspace).saves;
  if (saves.some((s) => within(s.path, target))) return { error: `The ${what} was not saved: that folder belongs to a loaded save, and the tool never writes into a save. Pick another folder.` };
  try {
    await fs.writeFile(target, await content(target));
  } catch (e) {
    return { error: `The ${what} could not be saved there: ${(e as NodeJS.ErrnoException).code === 'EBUSY' ? 'the file is open in another program.' : (e as Error).message}` };
  }
  return { path: target };
}

/** Builds the report in the engine, asks where to save it and writes it. The extension picks the format: .pdf, else HTML. */
async function exportReport(incidentId: unknown, options: unknown, settings: unknown): Promise<Saved> {
  let html: string;
  try {
    html = (await callEngine('report', [incidentId, options, settings])) as string;
  } catch (e) {
    return { error: `The report could not be built: ${(e as Error).message}` };
  }
  return saveAs('report', 'report.html', [{ name: 'Web page (*.html)', extensions: ['html'] }, { name: 'PDF (*.pdf)', extensions: ['pdf'] }],
    async (target) => (path.extname(target).toLowerCase() === '.pdf' ? await pdf(html) : html));
}
ipcMain.handle('exportReport', (_e, incidentId, options, settings) => exportReport(incidentId, options, settings));

/** A table the page made as CSV text (shared/csv.ts). Only the file name is the page's: no folder, nothing but plain characters. */
const KINDS: Record<string, Electron.FileFilter> = { csv: { name: 'CSV table (*.csv)', extensions: ['csv'] } };
ipcMain.handle('saveText', (_e, defaultName: unknown, text: unknown, kind: unknown) => {
  const filter = typeof kind === 'string' ? KINDS[kind] : undefined;
  if (!filter || typeof text !== 'string' || typeof defaultName !== 'string') return { error: 'The table could not be exported: the page sent something the tool does not save.' };
  const name = path.basename(defaultName).replace(/[^\w.-]/g, '_').slice(0, 120) || `table.${kind}`;
  return saveAs('table', name, [filter], async () => text);
});

app.on('window-all-closed', () => app.quit());
void app.whenReady().then(() => {
  startEngine();
  createWindow();
});

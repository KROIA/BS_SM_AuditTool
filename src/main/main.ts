// The window process. It opens the window, shows the folder dialog and passes calls on to the engine.
// It holds no logic of its own, and the screens get no file or system access (see preload.cts).
import { app, BrowserWindow, dialog, ipcMain, Menu, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';

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
  win.once('ready-to-show', () => win?.show());
  void win.loadFile(path.join(here, '../../ui/index.html'));
}

// The screen tests give the program a data folder of its own, so they never see a person's workspace.
if (process.env.AUDIT_TOOL_DATA) app.setPath('userData', path.resolve(process.env.AUDIT_TOOL_DATA));
Menu.setApplicationMenu(null);
ipcMain.handle('engine', (_e, method, args) => callEngine(method, args));
ipcMain.handle('startupPaths', () => startupPaths());
ipcMain.handle('pickFolder', async () => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { title: 'Open a save', properties: ['openDirectory'] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

app.on('window-all-closed', () => app.quit());
void app.whenReady().then(() => {
  startEngine();
  createWindow();
});

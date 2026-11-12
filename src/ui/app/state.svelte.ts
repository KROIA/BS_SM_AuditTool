// What the whole program shares: the open screen, the theme, the loaded saves and what is being loaded.
import type { Progress, RemoteEngine, SaveSummary, Scope, Workspace } from '../../shared/api.ts';

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  pickFolder(): Promise<string | null>;
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
  /** True while the engine reads a save; `loading` then says how far it is. */
  busy: false,
  loading: null as Progress | null,
});

addEventListener('hashchange', () => (app.route = routeFromHash()));
bridge.onProgress((p) => (app.loading = p));

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
  } catch (e) {
    // Electron wraps the engine's sentence in its own; show only the engine's.
    app.errors.push((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  } finally {
    app.busy = false;
    app.loading = null;
  }
}

/** Reads the folders one after the other. Folders opened while others are read join the end of the queue. */
export async function addSaves(paths: string[]) {
  const idle = app.queue.length === 0;
  if (idle) app.errors = [];
  app.queue.push(...paths);
  if (!idle) return;
  while (app.queue.length) {
    await run(() => engine.addSave(app.queue[0]!));
    app.queue.shift();
  }
}

export function removeSave(path: string) {
  app.errors = [];
  return run(() => engine.removeSave(path));
}

export async function browse() {
  const path = await bridge.pickFolder();
  if (path) await addSaves([path]);
}

/** Folders dropped onto the page. Things that are not folders are passed on too: the engine says what is wrong with them. */
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
  await run(() => engine.workspace());
  await addSaves(await bridge.startupPaths());
}

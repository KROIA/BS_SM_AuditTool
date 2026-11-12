// What the whole program shares: the open screen, the theme, the loaded saves and what is being loaded.
import type { Progress, RemoteEngine, SaveSummary, Scope, Workspace } from '../../shared/api.ts';

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  pickFolder(): Promise<string | null>;
  startupPaths(): Promise<string[]>;
  onProgress(listener: (p: Progress) => void): void;
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
  /** What went wrong with the last save that was opened, in plain words. */
  error: '',
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
    app.error = '';
  } catch (e) {
    // Electron wraps the engine's sentence in its own; show only the engine's.
    app.error = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  } finally {
    app.busy = false;
    app.loading = null;
  }
}

export const addSave = (path: string) => run(() => engine.addSave(path));
export const removeSave = (path: string) => run(() => engine.removeSave(path));

export async function browse() {
  const path = await bridge.pickFolder();
  if (path) await addSave(path);
}

/** Brings back the saves of the last session, then opens the folders given on the command line. */
export async function start() {
  await run(() => engine.workspace());
  for (const path of await bridge.startupPaths()) await addSave(path);
}

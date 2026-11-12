// What the whole program shares: the open screen, the theme and the loaded saves.
import type { RemoteEngine, SaveSummary } from '../../shared/api.ts';

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  pickFolder(): Promise<string | null>;
  startupPaths(): Promise<string[]>;
}
const bridge = (window as unknown as { audit: Bridge }).audit;

/** The engine, called like a local object: engine.openSave(path). */
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
  /** What went wrong with the last save that was opened, in plain words. */
  error: '',
});

addEventListener('hashchange', () => (app.route = routeFromHash()));

export function toggleTheme() {
  app.theme = app.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', app.theme);
  } catch {
    // the choice then only lasts until the program closes
  }
}

export async function addSave(path: string) {
  try {
    const save = await engine.openSave(path);
    app.saves = [...app.saves.filter((s) => s.path !== save.path), save];
    app.error = '';
  } catch (e) {
    // Electron wraps the engine's sentence in its own; show only the engine's.
    app.error = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
}

export async function browse() {
  const path = await bridge.pickFolder();
  if (path) await addSave(path);
}

export async function openStartupSaves() {
  for (const path of await bridge.startupPaths()) await addSave(path);
}

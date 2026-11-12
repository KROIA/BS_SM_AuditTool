// Entry point of the engine's background process. It answers calls from the window process, one at a time,
// and reports progress while a save is being read. The workspace folder is its first argument.
import { api } from './api.ts';
import { init } from './workspace.ts';

interface Call { id: number; method: string; args: unknown[] }
interface ParentPort {
  on(event: 'message', listener: (event: { data: Call }) => void): void;
  postMessage(message: unknown): void;
}
const port = (process as unknown as { parentPort: ParentPort }).parentPort;

init(process.argv[2]!, (progress) => port.postMessage({ progress }));

port.on('message', ({ data }) => {
  const { id, method, args } = data;
  try {
    // Only the functions listed in api can be called, whatever name arrives.
    if (!Object.hasOwn(api, method)) throw new Error(`The engine has no call named "${method}".`);
    const fn = api[method as keyof typeof api] as (...a: unknown[]) => unknown;
    port.postMessage({ id, ok: true, result: fn(...args) });
  } catch (e) {
    port.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

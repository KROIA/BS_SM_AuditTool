// One worker thread of the region scan (engine/scan.ts): reads one region file per task and sends back what it found.
// workerData: the main save's money item names by number (for the stockpile) and the names of the valuables.
import { parentPort, workerData } from 'node:worker_threads';
import { worthOf } from './players.ts';
import { scanRegion } from './region.ts';

export interface ScanTask { file: string }
export type ScanAnswer = ReturnType<typeof scanRegion> & { file: string; error: string | null };

const { names, valuables } = workerData as { names: [number, string][]; valuables: string[] };
const moneyName = new Map(names), valuable = new Set(valuables);

parentPort!.on('message', ({ file }: ScanTask) => {
  let answer: ScanAnswer;
  try {
    // Money, plain or altered (the query counts altered notes apart), and plain valuables.
    answer = { file, error: null, ...scanRegion(file, (f) => worthOf(f.item) !== null || (f.plain && valuable.has(f.item)), (id) => moneyName.get(id)) };
  } catch (e) {
    answer = { file, error: e instanceof Error ? e.message : String(e), chunks: 0, damaged: 0, lz4: 0, tooLarge: 0, finds: [] };
  }
  parentPort!.postMessage(answer);
});

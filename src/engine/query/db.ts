// What every question module needs from the cache database: rows with bigints, the name lookup, and the step series of snapshots.
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { Point, Scope } from '../../shared/api.ts';

export type Row = Record<string, SQLOutputValue>;
export function all(db: DatabaseSync, sql: string, params: Record<string, SQLInputValue> = {}): Row[] {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  return st.all(params) as Row[];
}
export const num = (v: SQLOutputValue) => (v === null ? null : Number(v));
export const big = (v: SQLOutputValue) => (v === null ? null : BigInt(v as bigint));
export const text = (v: SQLOutputValue) => (v === null ? null : String(v));

/** Player names: the one lookup every name goes through. Unknown players get the name a row gave, else the start of their UUID. */
export function names(db: DatabaseSync) {
  const map = new Map(all(db, 'SELECT uuid, name FROM player').map((r) => [String(r.uuid), String(r.name)]));
  return (uuid: string, fallback?: string | null) => map.get(uuid) ?? fallback ?? uuid.slice(0, 8);
}

/**
 * Snapshot rows (account, item, time, v), oldest first and already cut at the scope's end, as one value over time:
 * per account and item the last snapshot at or before each point, summed.
 * The range starts with what was held at its start.
 */
export function series(rows: Row[], scope: Scope): Point[] {
  const last = new Map<string, bigint>();
  let sum = 0n, before: bigint | null = null;
  const out: Point[] = [];
  for (const r of rows) {
    const key = `${r.account}:${r.item}`, v = big(r.v)!, t = num(r.time)!;
    sum += v - (last.get(key) ?? 0n);
    last.set(key, v);
    if (scope.from !== null && t < scope.from) before = sum;
    else if (out.at(-1)?.[0] === t) out.at(-1)![1] = sum;
    else out.push([t, sum]);
  }
  if (before !== null && out[0]?.[0] !== scope.from) out.unshift([scope.from!, before]);
  return out;
}

// Tables as CSV files (AT-44): RFC 4180 with CRLF line ends, UTF-8 with a byte order mark so Excel reads the
// characters right. Every number goes through fmt.ts, in full: 1'532.05. Save data is untrusted: a text cell that a
// spreadsheet would read as a formula gets a leading apostrophe. Number cells are typed and never changed.
import { amount, count, items } from './fmt.ts';

/** The separator: ";", so the file opens straight in Swiss and German Excel (user, 2026-11-13). The numbers never hold it. */
export const SEP = ';';

/**
 * text and id: written as they are, guarded against formulas. money: raw (real x 100), two decimals. quantity: raw item
 * units (count x 100), decimals only when there are any. count: a whole number. number: a measured value, two decimals at
 * most. time: epoch ms as yyyy-mm-dd hh:mm:ss in this computer's time zone, which the header names.
 */
export type Kind = 'text' | 'id' | 'money' | 'quantity' | 'count' | 'number' | 'time';
export type Column = readonly [header: string, kind: Kind];
export type Cell = string | number | bigint | boolean | null | undefined;
export interface Table { columns: readonly Column[]; rows: readonly (readonly Cell[])[] }

const two = (n: number) => String(n).padStart(2, '0');
/** 2026-11-04 10:21:07 in the computer's time zone. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
/** The computer's time zone, for the headers of time columns. */
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

/** A cell as the column's kind writes it; empty for null. */
function cell(v: Cell, kind: Kind): string {
  if (v === null || v === undefined || v === '') return '';
  switch (kind) {
    case 'money': return amount(BigInt(v as bigint));
    case 'quantity': return items(BigInt(v as bigint));
    case 'count': return count(v as number | bigint);
    case 'number': return items(BigInt(Math.round(Number(v) * 100)));
    case 'time': return stamp(Number(v));
    default: {
      const s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
      return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // a formula in a spreadsheet; the apostrophe makes it text
    }
  }
}
const quote = (s: string) => (s.includes(SEP) || /["\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

/** The whole file: the byte order mark, the header (time columns name the zone), then one line per row, each ending in CRLF. */
export function csv({ columns, rows }: Table): string {
  const z = zone();
  const head = columns.map(([h, kind]) => quote(cell(kind === 'time' ? `${h} (${z})` : h, 'text')));
  return '﻿' + [head, ...rows.map((r) => columns.map(([, kind], i) => quote(cell(r[i], kind))))].map((l) => l.join(SEP) + '\r\n').join('');
}

/** The file name the save dialog proposes: players-orders-2026-11-13.csv */
export const csvName = (screen: string, table: string, now = Date.now()) => `${screen}-${table}-${stamp(now).slice(0, 10)}.csv`;

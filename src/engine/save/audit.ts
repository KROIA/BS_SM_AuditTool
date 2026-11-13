// The bank's audit log: data/BankSystem/audit/<yyyy-mm-dd>.log (BS AdminAudit.java).
// One entry per admin action and per flag, each starting with "yyyy-MM-dd HH:mm:ss " in the server's local time,
// without a zone. Details and notes are not escaped, so an entry can span several lines.
// Untrusted input: the total size and each entry are bounded, and what does not parse is kept as raw text.
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_LIMITS = { total: 64 * 1024 * 1024, entry: 64 * 1024 };

export interface AuditEntry {
  /** Server local time read as if it were UTC (ms). null for raw text without a readable start. */
  local: number | null;
  /** FLAG and ADMIN as the mod writes them, CHANGE for BS-257 lines (no ledger row), RAW for anything else. */
  kind: 'FLAG' | 'ADMIN' | 'CHANGE' | 'RAW';
  /** The flag code (FLAG) or the type (ADMIN_SET, RIGHTS_OP, ...). */
  type: string | null;
  account: number | null;
  item: number | null;
  amount: bigint | null;
  severity: number | null;
  ref: string | null;
  /** Player name, or the source (ADMIN, CONSOLE, ...) when no player acted. */
  actor: string | null;
  actorUuid: string | null;
  /** RIGHTS_OP and RIGHTS_DEOP: the player whose rights changed. */
  player: string | null;
  /** BS-257: what changed, in the mod's words, and its new state. */
  subject: string | null;
  state: string | null;
  /** Flag details, the admin's note, or the raw text. */
  text: string | null;
}

const START = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) /;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const FLAG = /^FLAG (\d{1,9}) account (-?\d{1,10}) severity (-?\d{1,9})(?: amount (-?\d{1,19}))?(?: ref (\S+))?(?: "([\s\S]*)")?$/;
const ADMIN = new RegExp(`^ADMIN (\\w+) account (-?\\d{1,10})(?: item (\\d{1,10}))?(?: amount (-?\\d{1,19}))? by (\\S+)(?: \\((${UUID})\\))?(?: note "([\\s\\S]*)")?$`);
const CHANGE = new RegExp(`^ADMIN (\\w+) ([\\s\\S]+) state (\\S+) by (\\S+)(?: \\((${UUID})\\))?$`);
const MAX_LONG = 9_223_372_036_854_775_807n;

const blank = (local: number | null, kind: AuditEntry['kind'], text: string | null = null): AuditEntry => ({
  local, kind, type: null, account: null, item: null, amount: null, severity: null, ref: null, actor: null, actorUuid: null, player: null, subject: null, state: null, text,
});
const int = (s: string | undefined) => (s === undefined ? null : Number(s));
const long = (s: string | undefined) => {
  if (s === undefined) return 0n; // the mod leaves a zero amount out
  const v = BigInt(s);
  if (v > MAX_LONG || v < -MAX_LONG - 1n) throw new RangeError('amount beyond 64 bits');
  return v;
};
const lower = (s: string | undefined) => s?.toLowerCase() ?? null;

/** One entry: its first line with the time, continuation lines joined with \n. */
export function parseEntry(text: string): AuditEntry {
  const m = START.exec(text);
  if (!m) return blank(null, 'RAW', text);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const local = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = new Date(local);
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return blank(null, 'RAW', text);
  const body = text.slice(m[0].length);
  try {
    let r: RegExpExecArray | null;
    if ((r = FLAG.exec(body))) {
      return { ...blank(local, 'FLAG', r[6] ?? null), type: r[1]!, account: int(r[2]), severity: int(r[3]), amount: long(r[4]), ref: r[5] ?? null };
    }
    if ((r = ADMIN.exec(body))) {
      return { ...blank(local, 'ADMIN', r[7] ?? null), type: r[1]!, account: int(r[2]), item: int(r[3]), amount: long(r[4]), actor: r[5]!, actorUuid: lower(r[6]) };
    }
    if ((r = CHANGE.exec(body))) {
      // Subjects (BS ServerBankManager, AsyncCompanyManager): player <uuid> "<name>", slave "<id>", item <id> "<name>",
      // company <id> "<name>" account <n> flag SHARE_EXCESS excess <n>.
      const subject = r[2]!;
      return {
        ...blank(local, 'CHANGE'), type: r[1]!, subject, state: r[3]!, actor: r[4]!, actorUuid: lower(r[5]),
        player: lower(new RegExp(`^player (${UUID}) `).exec(subject)?.[1]), item: int(/^item (\d{1,10}) /.exec(subject)?.[1]),
        account: int(/^company \d+ "[^\n]*" account (\d{1,10}) /.exec(subject)?.[1]),
      };
    }
  } catch {
    // an amount beyond 64 bits: raw text
  }
  return blank(local, 'RAW', text);
}


/** The entries of every <yyyy-mm-dd>.log, oldest file first, each with the index of its file in files (the dates). null without an audit folder. */
export function readAuditLog(dataDir: string, limits = AUDIT_LIMITS): { entries: (AuditEntry & { file: number })[]; files: string[]; bytes: number; bounded: boolean } | null {
  const dir = path.join(dataDir, 'BankSystem', 'audit');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort(); // digest-*.md and anything else are skipped
  } catch {
    return null;
  }
  const entries: (AuditEntry & { file: number })[] = [], files: string[] = [];
  let bytes = 0, bounded = false;
  for (const name of names) {
    let text: string;
    try {
      const file = path.join(dir, name), size = fs.statSync(file).size;
      const take = Math.min(size, limits.total - bytes);
      if (take < size) bounded = true;
      const buf = Buffer.alloc(take), fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buf, 0, take, 0);
      } finally {
        fs.closeSync(fd);
      }
      bytes += take;
      text = buf.toString('utf8');
    } catch {
      continue; // unreadable file: left out
    }
    const index = files.push(name.slice(0, 10)) - 1;
    let entry: string | null = null;
    const done = () => {
      if (entry !== null) entries.push({ ...(entry.length > limits.entry ? blank(null, 'RAW', entry.slice(0, limits.entry)) : parseEntry(entry)), file: index });
    };
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      if (START.test(line) || entry === null) {
        done();
        entry = line.slice(0, limits.entry + 1);
      } else if (entry.length <= limits.entry) entry += '\n' + line.slice(0, limits.entry + 1);
    }
    done();
    if (bounded) break;
  }
  return { entries, files, bytes, bounded };
}

const QUARTER = 15 * 60_000, SLACK = 2_000, MAX_OFFSET = 14 * 3_600_000;

/** A row of the database an entry can be matched to. key: what both share (account, code or type, amount). */
export interface TimedRow { id: number; ts: number; key: string }
/** How a file's offset was found: its own matches, a neighbouring file's, or approximate (disagreeing matches, or this computer's zone). */
export interface FileZone { offset: number | null; how: 'matched' | 'neighbour' | 'approximate' }

/**
 * The offset of the server's local time per log file (one file is one date, so a clock change falls between files or
 * inside one). An entry matches a row with an epoch time when both have the same key and the local time is a multiple
 * of 15 minutes away from the row's time, within 2 seconds (the log keeps whole seconds).
 * - A file whose matches agree takes that offset.
 * - A file without matches takes the nearest earlier file's offset, else the nearest later one's. When the earlier and
 *   the later one disagree, the earlier one, approximate.
 * - A file whose own matches disagree (the clock changed that day) takes its most frequent offset, approximate.
 * - Without any offset, times are read in this computer's zone, approximate (offset null).
 * Returns each file's zone and each entry's epoch time, whether it is approximate, and its matched row.
 */
export function placeInTime(entries: { local: number | null; key: string | null; file: number }[], rows: TimedRow[], files: number) {
  const byKey = new Map<string, TimedRow[]>();
  for (const r of rows) (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!).push(r);
  const candidates = entries.map((e) => (e.local === null || e.key === null ? [] : (byKey.get(e.key) ?? []).flatMap((row) => {
    const diff = e.local! - row.ts, q = Math.round(diff / QUARTER) * QUARTER;
    return Math.abs(q) <= MAX_OFFSET && Math.abs(diff - q) <= SLACK ? [{ row, q, off: Math.abs(diff - q) }] : [];
  })));
  const votes = Array.from({ length: files }, () => new Map<number, number>()); // per file: offset -> entries; first seen first
  entries.forEach((e, i) => {
    for (const q of new Set(candidates[i]!.map((c) => c.q))) votes[e.file]!.set(q, (votes[e.file]!.get(q) ?? 0) + 1);
  });
  const own = votes.map((v) => (v.size === 1 ? [...v.keys()][0]! : null));
  const zones = votes.map((v, f): FileZone => {
    if (own[f] !== null) return { offset: own[f]!, how: 'matched' };
    if (v.size > 1) return { offset: [...v].reduce((a, b) => (b[1] > a[1] ? b : a))[0], how: 'approximate' };
    const before = own.slice(0, f).findLast((o) => o !== null) ?? null, after = own.slice(f + 1).find((o) => o !== null) ?? null;
    if (before === null && after === null) return { offset: null, how: 'approximate' };
    return { offset: before ?? after, how: before !== null && after !== null && before !== after ? 'approximate' : 'neighbour' };
  });

  const used = new Set<number>();
  const placed = entries.map((e, i) => {
    const z = zones[e.file]!;
    let ts: number | null = null;
    if (e.local !== null) {
      const d = new Date(e.local);
      ts = z.offset !== null ? e.local - z.offset
        : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime();
    }
    const exact = z.how !== 'approximate';
    const best = candidates[i]!.filter((c) => !used.has(c.row.id) && (!exact || c.q === z.offset)).sort((a, b) => a.off - b.off)[0];
    if (best) used.add(best.row.id);
    return { ts, approximate: !exact, row: best?.row.id ?? null };
  });
  return { zones, matches: placed.filter((p) => p.row !== null).length, placed };
}

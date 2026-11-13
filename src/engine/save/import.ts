// Reads one save into its cache database, once. Every screen then asks the cache, never the save.
// The save is only ever read: its databases are copied out first, and the copies are deleted after the import.
// A damaged database gives up what is readable; the unreadable id ranges are counted and reported.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SaveSource, SaveSummary, SaveTable } from '../../shared/api.ts';
import { time } from '../../shared/fmt.ts';
import { placeInTime, readAuditLog } from './audit.ts';
import { readBankAudit, readFiles, readUserCache } from './files.ts';
import { findDataDir, readIdentity, readLevel } from './locate.ts';

/** Raise when the layout of the cache changes: caches written by an older version are rebuilt. */
export const CACHE_VERSION = 9;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE candle (id INTEGER PRIMARY KEY, market INTEGER NOT NULL, time INTEGER NOT NULL, open INTEGER NOT NULL, low INTEGER NOT NULL, high INTEGER NOT NULL, volume REAL NOT NULL);
CREATE TABLE candle_hour (market INTEGER NOT NULL, time INTEGER NOT NULL, open INTEGER NOT NULL, low INTEGER NOT NULL, high INTEGER NOT NULL, volume REAL NOT NULL, PRIMARY KEY (market, time)) WITHOUT ROWID;
CREATE TABLE orders (id INTEGER PRIMARY KEY, order_id INTEGER, item INTEGER NOT NULL, account INTEGER NOT NULL, player TEXT NOT NULL, type INTEGER NOT NULL, amount INTEGER NOT NULL, price INTEGER NOT NULL, time INTEGER NOT NULL, finish_time INTEGER);
CREATE TABLE ledger (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, account INTEGER NOT NULL, actor TEXT, actor_name TEXT, source_kind TEXT, kind TEXT NOT NULL, type_code INTEGER, item INTEGER NOT NULL, amount INTEGER NOT NULL, other_account INTEGER, company_id INTEGER, note TEXT, ref TEXT, tag TEXT, money_amount INTEGER, price INTEGER, currency_item INTEGER, balance_after INTEGER, virtual_qty INTEGER);
CREATE TABLE snapshot (id INTEGER PRIMARY KEY, account INTEGER NOT NULL, item INTEGER NOT NULL, time INTEGER NOT NULL, balance INTEGER NOT NULL, locked INTEGER NOT NULL);
CREATE TABLE flag (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, account INTEGER NOT NULL, flag_type INTEGER NOT NULL, severity INTEGER NOT NULL, amount INTEGER NOT NULL, ref TEXT, details TEXT, acknowledged INTEGER NOT NULL);
CREATE TABLE transfer_step (id INTEGER PRIMARY KEY, transfer_id TEXT NOT NULL, ts INTEGER NOT NULL, direction TEXT, path TEXT, step TEXT NOT NULL, account INTEGER, player TEXT, items_json TEXT, ledger_type INTEGER, context TEXT, detail TEXT);
CREATE TABLE note_flow (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, player TEXT, item INTEGER NOT NULL, amount INTEGER NOT NULL, context TEXT, villager TEXT, dimension TEXT, x INTEGER, y INTEGER, z INTEGER);
CREATE TABLE audit (id INTEGER PRIMARY KEY, ts INTEGER, approx INTEGER NOT NULL, local INTEGER, kind TEXT NOT NULL, type TEXT, account INTEGER, item INTEGER, amount INTEGER, severity INTEGER, ref TEXT, actor TEXT, actor_uuid TEXT, player TEXT, subject TEXT, state TEXT, text TEXT, row_id INTEGER);
CREATE TABLE order_origin (ref TEXT PRIMARY KEY, server_uid TEXT, name TEXT NOT NULL);
CREATE TABLE diag_meta (source TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
CREATE TABLE player (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, bank_admin INTEGER NOT NULL, market_admin INTEGER NOT NULL);
CREATE TABLE account (number INTEGER PRIMARY KEY, name TEXT NOT NULL, frozen INTEGER NOT NULL, created_ms INTEGER, owner TEXT, company TEXT);
CREATE TABLE account_user (account INTEGER NOT NULL, uuid TEXT NOT NULL, permissions INTEGER NOT NULL, PRIMARY KEY (account, uuid)) WITHOUT ROWID;
CREATE TABLE balance (account INTEGER NOT NULL, item INTEGER NOT NULL, balance INTEGER NOT NULL, locked INTEGER NOT NULL, PRIMARY KEY (account, item)) WITHOUT ROWID;
CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL, money INTEGER NOT NULL);
CREATE TABLE market (item INTEGER PRIMARY KEY, price INTEGER, default_price INTEGER, maintenance INTEGER NOT NULL);
`;
// open is in the candle index so that the usual price (the median open) is read from the index alone: 0.3 s less per market on a real save.
const INDEXES = `
CREATE INDEX candle_market_time ON candle (market, time, open);
CREATE INDEX orders_player_time ON orders (player, time);
CREATE INDEX orders_item_time ON orders (item, time);
CREATE INDEX orders_account_time ON orders (account, time);
CREATE INDEX orders_order_id ON orders (order_id);
CREATE INDEX ledger_account_ts ON ledger (account, ts);
CREATE INDEX ledger_actor_ts ON ledger (actor, ts);
CREATE INDEX ledger_ref ON ledger (ref);
CREATE INDEX snapshot_series ON snapshot (account, item, time);
CREATE INDEX transfer_step_id ON transfer_step (transfer_id);
`;

/** A UUID kept as two signed 64-bit halves, as text: a1b2c3d4-e5f6-4a7b-8c9d-000000000001 */
const uuid = (high: string, low: string) =>
  `(SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21) FROM (SELECT printf('%016x%016x', ${high}, ${low}) AS h))`;

interface Column { to: string; from: string; needs?: string[] } // needs: the source columns an expression uses
interface TableImport { source: SaveSource['id']; from: string; to: string; time?: string; columns: Column[]; fixed?: Record<string, string> }
const same = (...names: string[]): Column[] => names.map((n) => ({ to: n, from: n }));

/** Which table of the mods goes into which table of the cache. A source column that an older save lacks becomes NULL. */
const TABLES: TableImport[] = [
  { source: 'market', from: 'MarketPrice', to: 'candle', time: 'time',
    columns: [...same('id', 'time', 'open', 'low', 'high'), { to: 'market', from: 'marketid' }, { to: 'volume', from: 'traded_volume' }] },
  { source: 'market', from: 'OrderHistory', to: 'orders', time: 'time',
    columns: [...same('id', 'order_id', 'type', 'amount', 'price', 'time', 'finish_time'), { to: 'item', from: 'itemid' }, { to: 'account', from: 'accountid' },
      { to: 'player', from: uuid('userid_one', 'userid_two'), needs: ['userid_one', 'userid_two'] }] },
  { source: 'bank', from: 'TransactionLog', to: 'ledger', time: 'ts',
    columns: [...same('id', 'ts', 'actor_name', 'source_kind', 'kind', 'type_code', 'amount', 'other_account', 'company_id', 'note', 'ref', 'tag', 'money_amount', 'price', 'currency_item', 'balance_after', 'virtual_qty'),
      { to: 'account', from: 'account_number' }, { to: 'actor', from: 'lower(actor_uuid)', needs: ['actor_uuid'] }, { to: 'item', from: 'item_id' }] },
  { source: 'bank', from: 'BalanceHistory', to: 'snapshot', time: 'time',
    columns: [...same('id', 'time', 'balance'), { to: 'account', from: 'account_number' }, { to: 'item', from: 'item_id' }, { to: 'locked', from: 'locked_balance' }] },
  { source: 'bank', from: 'SuspicionFlag', to: 'flag', time: 'ts',
    columns: [...same('id', 'ts', 'flag_type', 'severity', 'amount', 'ref', 'details', 'acknowledged'), { to: 'account', from: 'account_number' }] },
  { source: 'bankDiag', from: 'TransferJournal', to: 'transfer_step', time: 'ts',
    columns: [...same('id', 'transfer_id', 'ts', 'direction', 'path', 'step', 'items_json', 'ledger_type', 'context', 'detail'),
      { to: 'account', from: 'account_number' }, { to: 'player', from: 'lower(player_uuid)', needs: ['player_uuid'] }] },
  { source: 'bankDiag', from: 'NoteFlow', to: 'note_flow', time: 'ts',
    columns: [...same('id', 'ts', 'source', 'amount', 'context', 'dimension', 'x', 'y', 'z'), { to: 'item', from: 'item_id' },
      { to: 'player', from: 'lower(player_uuid)', needs: ['player_uuid'] }, { to: 'villager', from: 'lower(villager_uuid)', needs: ['villager_uuid'] }] },
  { source: 'bankDiag', from: 'Meta', to: 'diag_meta', columns: same('key', 'value'), fixed: { source: "'bank'" } },
  { source: 'marketDiag', from: 'OrderOrigin', to: 'order_origin',
    columns: [{ to: 'ref', from: 'ref' }, { to: 'server_uid', from: 'origin_server_uid' }, { to: 'name', from: 'origin_name' }] },
  { source: 'marketDiag', from: 'Meta', to: 'diag_meta', columns: same('key', 'value'), fixed: { source: "'market'" } },
];
const FILES: Record<Exclude<SaveSource['id'], 'audit'>, string> = {
  bank: 'BankSystem/Database/banksystem.db',
  market: 'StockMarket/Database/stockdata.db',
  bankDiag: 'BankSystem/Database/banksystem_diagnostics.db',
  marketDiag: 'StockMarket/Database/stockmarket_diagnostics.db',
};
const SOURCE_IDS = Object.keys(FILES) as (keyof typeof FILES)[];
// A database's -wal and -journal hold changes its main file does not show yet; the NBT folders and level.dat feed the summary too.
const FINGERPRINT_FILES = [
  ...Object.values(FILES).flatMap((f) => [f, f + '-wal', f + '-journal']),
  'ModUtilities/server_identity.json', 'BankSystem/ItemIDs.nbt', 'BankSystem/Meta_data.nbt', 'BankSystem/settings.json', '../level.dat', '../../usercache.json',
];
const FINGERPRINT_DIRS = ['BankSystem/audit', 'BankSystem/Bank_data', 'BankSystem/Companies', 'StockMarket/MarketManager'];
const CHUNK = 200_000; // ids per insert; a failing insert is halved until the damage is fenced in
const SMALLEST = 64;

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const sqlText = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

export type Report = (step: string, done: number, total: number) => void;

/** What identifies the state of a save on disk. When it is unchanged, the cache is still good. */
export function fingerprint(picked: string): string {
  const dataDir = findDataDir(picked);
  const inside = (dir: string) => {
    try {
      return (fs.readdirSync(path.join(dataDir, dir), { recursive: true }) as string[]).sort().map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  };
  const files = [...FINGERPRINT_FILES, ...FINGERPRINT_DIRS.flatMap(inside)].map((f) => {
    const s = fs.statSync(path.join(dataDir, f), { throwIfNoEntry: false });
    return s ? `${f}:${s.size}:${Math.round(s.mtimeMs)}` : `${f}:-`;
  });
  return JSON.stringify([CACHE_VERSION, ...files]);
}

/** The cached summary of a save, or null when there is no cache or the save has changed since. */
export function cachedSummary(cacheFile: string, picked: string): SaveSummary | null {
  if (!isFile(cacheFile)) return null;
  try {
    const db = new DatabaseSync(cacheFile, { readOnly: true });
    try {
      const get = (key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
      if (get('fingerprint') !== fingerprint(picked)) return null;
      const summary = get('summary');
      return summary ? (JSON.parse(summary) as SaveSummary) : null;
    } finally {
      db.close();
    }
  } catch {
    return null; // an unreadable cache is simply rebuilt
  }
}

interface Copied { rows: number; lostIds: number; newestLost: boolean; has: Set<string> }

/** Copies one table in id ranges. Returns the rows read, the ids that could not be, and the columns the source has. */
function copyTable(db: DatabaseSync, t: TableImport, report: Report): Copied | null {
  const src = `src.${quote(t.from)}`;
  let has: Set<string>;
  try {
    has = new Set((db.prepare(`PRAGMA src.table_info(${quote(t.from)})`).all() as { name: string }[]).map((c) => c.name));
  } catch {
    return null;
  }
  if (has.size === 0) return null; // the table does not exist in this save
  const columns = t.columns.map((c) => ({ to: c.to, expr: (c.needs ?? [c.from]).every((n) => has.has(n)) ? c.from : 'NULL' }));
  for (const [to, expr] of Object.entries(t.fixed ?? {})) columns.push({ to, expr });
  const insert = `INSERT INTO main.${t.to} (${columns.map((c) => c.to).join(', ')}) SELECT ${columns.map((c) => c.expr).join(', ')} FROM ${src}`;
  const countRows = () => (db.prepare(`SELECT count(*) AS n FROM main.${t.to}`).get() as { n: number }).n;
  const before = countRows();

  if (!has.has('id')) { // small tables without an id: all or nothing
    try {
      db.exec(insert);
    } catch {
      return { rows: 0, lostIds: 1, newestLost: false, has };
    }
    return { rows: countRows() - before, lostIds: 0, newestLost: false, has };
  }
  // The highest id. The mods' tables count their ids in sqlite_sequence; asking the table itself fails when its newest end is damaged.
  let last = 0;
  try {
    last = Number((db.prepare('SELECT seq FROM src.sqlite_sequence WHERE name = ?').get(t.from) as { seq: number | bigint } | undefined)?.seq ?? 0);
  } catch {
    // next try
  }
  if (!last) {
    try {
      last = Number((db.prepare(`SELECT max(id) AS m FROM ${src}`).get() as { m: number | bigint | null }).m ?? 0);
    } catch {
      return { rows: 0, lostIds: 1, newestLost: true, has };
    }
  }

  const ranged = db.prepare(`${insert} WHERE id BETWEEN ? AND ?`);
  let lostIds = 0;
  // No surrounding transaction on purpose: each insert stands alone, so a failing one undoes only itself.
  const copy = (lo: number, hi: number) => {
    try {
      ranged.run(lo, hi);
    } catch {
      if (hi - lo < SMALLEST) {
        lostIds += hi - lo + 1;
        return;
      }
      const mid = Math.floor((lo + hi) / 2);
      copy(lo, mid);
      copy(mid + 1, hi);
    }
  };
  for (let lo = 1; lo <= last; lo += CHUNK) {
    const hi = Math.min(last, lo + CHUNK - 1);
    copy(lo, hi);
    report(t.from, hi, last);
  }
  // A copy taken while the mod was writing can hold rows past the id that sqlite_sequence recorded. They are copied
  // when readable; when not, nothing says how many there were.
  let newestLost = false;
  try {
    ranged.run(last + 1, Number.MAX_SAFE_INTEGER);
  } catch {
    newestLost = true;
  }
  return { rows: countRows() - before, lostIds, newestLost, has };
}

const hours = (ms: number) => `${ms < 0 ? '-' : '+'}${String(Math.floor(Math.abs(ms) / 3_600_000)).padStart(2, '0')}:${String((Math.abs(ms) / 60_000) % 60).padStart(2, '0')}`;

/**
 * The bank's audit log into the audit table, after the flags and the ledger: its local times are placed by matching
 * FLAG entries to flag rows and ADMIN entries to ledger rows (DATA_SOURCES.md, "Files").
 */
function auditLog(db: DatabaseSync, dataDir: string, warnings: string[]): SaveSource {
  const log = readAuditLog(dataDir);
  if (!log) return { id: 'audit', status: 'none', bytes: 0, tables: [] };
  const key = (e: (typeof log.entries)[number]) =>
    e.kind === 'FLAG' ? `F:${e.account}:${e.type}:${e.amount}` : e.kind === 'ADMIN' ? `A:${e.account}:${e.type}:${e.amount}` : null;
  const rows = [
    ...(db.prepare('SELECT id, ts, account, flag_type, CAST(amount AS TEXT) AS amount FROM flag').all() as Record<string, number | bigint>[])
      .map((r) => ({ id: Number(r.id), ts: Number(r.ts), key: `F:${r.account}:${r.flag_type}:${r.amount}` })),
    ...(db.prepare("SELECT id, ts, account, kind, CAST(amount AS TEXT) AS amount FROM ledger WHERE kind LIKE 'ADMIN%' OR kind IN ('ACCOUNT_FREEZE', 'BANK_CLOSED', 'ACCOUNT_DELETE_LOSS')").all() as Record<string, number | bigint | string>[])
      .map((r) => ({ id: Number(r.id), ts: Number(r.ts), key: `A:${r.account}:${r.kind}:${r.amount}` })),
  ];
  const when = placeInTime(log.entries.map((e) => ({ local: e.local, key: key(e), file: e.file })), rows, log.files.length);
  const insert = db.prepare(`INSERT INTO audit (ts, approx, local, kind, type, account, item, amount, severity, ref, actor, actor_uuid, player, subject, state, text, row_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  log.entries.forEach((e, i) => {
    const p = when.placed[i]!;
    insert.run(p.ts, +p.approximate, e.local, e.kind, e.type, e.account, e.item, e.amount, e.severity, e.ref, e.actor, e.actorUuid, e.player, e.subject, e.state, e.text, p.row);
  });
  db.exec('COMMIT');

  const raw = log.entries.filter((e) => e.kind === 'RAW').length;
  const date = (f: number) => time(Date.parse(log.files[f]! + 'T00:00:00Z'), true).split(',')[0]!;
  // The offsets in file order: "UTC+02:00 until 26 Oct 2026, then UTC+01:00".
  const runs: { offset: number; from: number }[] = [];
  when.zones.forEach((z, f) => {
    if (z.offset !== null && runs.at(-1)?.offset !== z.offset) runs.push({ offset: z.offset, from: f });
  });
  let zone = 'times approximate (time zone unknown)';
  if (runs.length) {
    zone = 'server time ' + runs.map((r, i) => `UTC${hours(r.offset)}${runs[i + 1] ? ' until ' + date(runs[i + 1]!.from) : ''}`).join(', then ') +
      `, from ${when.matches} ${when.matches === 1 ? 'entry' : 'entries'} matched to the database`;
    const rough = when.zones.flatMap((z, f) => (z.how === 'approximate' ? [f] : []));
    if (rough.length) zone += rough.length <= 3 ? `, times of ${rough.map(date).join(', ')} approximate` : `, times of ${rough.length} days approximate`;
  } else {
    warnings.push("The bank's audit log gives its times without a time zone and none of its entries could be matched to the database. " +
      "Its times are read in this computer's time zone and may be off by whole hours.");
  }
  const ts = when.placed.flatMap((p) => (p.ts === null ? [] : [p.ts]));
  const days = new Map<number, number>();
  for (const t of ts) {
    const day = Math.floor(t / 86_400_000) * 86_400_000;
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return {
    id: 'audit', status: log.bounded ? 'damaged' : 'read', bytes: log.bytes,
    tables: [{ name: 'AuditLog', rows: log.entries.length, lostIds: 0, newestLost: log.bounded, from: ts.length ? ts.reduce((a, b) => Math.min(a, b)) : null, to: ts.length ? ts.reduce((a, b) => Math.max(a, b)) : null,
      days: [...days].sort((a, b) => a[0] - b[0]) }],
    note: zone + (raw ? `, ${raw} ${raw === 1 ? 'entry' : 'entries'} not readable (kept as text)` : ''),
  };
}

/** Reads a save into a new cache database at cacheFile and returns what was found. */
export function importSave(picked: string, cacheFile: string, report: Report = () => {}): SaveSummary {
  const dataDir = findDataDir(picked);
  const identity = readIdentity(dataDir);
  const level = readLevel(dataDir);
  const print = fingerprint(picked);
  const tmp = cacheFile + '.copies';
  for (const f of [cacheFile, cacheFile + '-journal']) fs.rmSync(f, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const db = new DatabaseSync(cacheFile);
  const found = new Map<SaveSource['id'], { bytes: number; tables: SaveTable[]; opened: boolean }>();
  let current = false; // a save of the current mods, as opposed to 2.1.2
  try {
    db.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF'); // a cache: losing it in a crash costs one reload
    db.exec(SCHEMA);
    for (const id of SOURCE_IDS) {
      const file = path.join(dataDir, FILES[id]);
      if (!isFile(file)) continue;
      const entry = { bytes: fs.statSync(file).size, tables: [] as SaveTable[], opened: false };
      found.set(id, entry);
      report('Copying the databases', 0, 1);
      const copy = path.join(tmp, path.basename(file));
      for (const ext of ['', '-wal', '-journal']) if (isFile(file + ext)) fs.copyFileSync(file + ext, copy + ext);
      try {
        db.exec(`ATTACH ${sqlText(copy)} AS src`);
      } catch {
        continue; // not a database: reported as damaged
      }
      try {
        db.prepare('SELECT count(*) FROM src.sqlite_master').get(); // fails here when the file is not a database
        entry.opened = true;
        for (const t of TABLES.filter((x) => x.source === id)) {
          const result = copyTable(db, t, report);
          if (!result) continue;
          let from: number | null = null, to: number | null = null, days: [number, number][] = [];
          if (t.time && result.rows) {
            report('Checking which days the data covers', 0, 1);
            days =(db.prepare(`SELECT ${t.time} / 86400000 * 86400000 AS d, count(*) AS n FROM main.${t.to} NOT INDEXED WHERE ${t.time} > 0 GROUP BY d ORDER BY d`)
              .all() as { d: number; n: number }[]).map((r) => [r.d, r.n]);
            // Rows with time 0 have no time (31 orders of the November case): they do not stretch the span to 1970.
            const span = db.prepare(`SELECT min(${t.time}) AS a, max(${t.time}) AS b FROM main.${t.to} WHERE ${t.time} > 0`).get() as { a: number | null; b: number | null };
            [from, to] = [span.a, span.b];
          }
          entry.tables.push({ name: t.from, rows: result.rows, lostIds: result.lostIds, newestLost: result.newestLost, from, to, days });
          // The current mods are recognised by columns that 2.1.2 did not have.
          if (t.from === 'TransactionLog' && result.has.has('type_code')) current = true;
          if (t.from === 'OrderHistory' && result.has.has('order_id')) current = true;
        }
        if (id === 'bankDiag' || id === 'marketDiag') current = true; // only the current mods write diagnostics
      } catch {
        entry.opened = entry.tables.length > 0; // whatever was read stays; the source counts as damaged
      } finally {
        db.exec('DETACH src');
      }
    }

    // The mods' NBT files: who the players are, which accounts exist, what the item numbers mean.
    report('Reading players, accounts and items', 0, 1);
    const files = readFiles(dataDir);
    const add = (table: string, rows: Record<string, string | number | bigint | null>[]) => {
      if (!rows.length) return;
      const cols = Object.keys(rows[0]!);
      const st = db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const r of rows) st.run(...Object.values(r));
    };
    // Names the mods' files lack come from the server's usercache.json, for players that traded or acted (not every visitor).
    const cache = readUserCache(dataDir);
    const listed = new Set(files.players.map((p) => p.uuid));
    const active = (db.prepare('SELECT player AS u FROM orders UNION SELECT actor FROM ledger WHERE actor IS NOT NULL').all() as { u: string }[]).map((r) => r.u);
    const players = [
      ...files.players.map((p) => ({ uuid: p.uuid, name: p.name || cache.get(p.uuid) || '', bank_admin: +p.bankAdmin, market_admin: +p.marketAdmin })),
      ...active.filter((u) => !listed.has(u) && cache.has(u)).map((u) => ({ uuid: u, name: cache.get(u)!, bank_admin: 0, market_admin: 0 })),
    ];
    db.exec('BEGIN');
    add('player', players);
    add('account', files.accounts.map((a) => ({ number: a.number, name: a.name, frozen: +a.frozen, created_ms: a.createdMs, owner: a.owner, company: a.company })));
    add('account_user', files.accounts.flatMap((a) => a.users.map((u) => ({ account: a.number, uuid: u.uuid, permissions: u.permissions }))));
    add('balance', files.accounts.flatMap((a) => a.balances.map((b) => ({ account: a.number, item: b.item, balance: b.balance, locked: b.locked }))));
    add('item', files.items.map((i) => ({ id: i.id, name: i.name, money: +i.money })));
    add('market', files.markets.map((m) => ({ item: m.item, price: m.price, default_price: m.defaultPrice, maintenance: +m.maintenance })));
    db.exec('COMMIT');

    report('Preparing the data for quick searching', 0, 1);
    db.exec(INDEXES);
    // 1-hour candles for long time ranges. The open is that of the hour's first minute.
    db.exec(`INSERT INTO candle_hour
      SELECT h.market, h.t, c.open, h.low, h.high, h.volume
      FROM (SELECT market, time / 3600000 * 3600000 AS t, min(time) AS first, min(low) AS low, max(high) AS high, sum(volume) AS volume FROM candle NOT INDEXED GROUP BY 1, 2) h
      JOIN candle c ON c.market = h.market AND c.time = h.first
      GROUP BY h.market, h.t`);

    const role = identity?.role ?? (found.has('bank') ? 'MASTER' : 'SLAVE');
    const warnings: string[] = [];
    if (!identity) warnings.push('This save has no server identity file. Its role was worked out from the files that were found.');
    const sources = SOURCE_IDS.map((id): SaveSource => {
      const f = found.get(id);
      if (f) {
        const damaged = !f.opened || f.tables.some((t) => t.lostIds > 0 || t.newestLost);
        return { id, status: damaged ? 'damaged' : 'read', bytes: f.bytes, tables: f.tables };
      }
      // What a save is expected to have: a slave keeps no bank or market data, and 2.1.2 wrote no diagnostics.
      const expected = role === 'SLAVE' ? id === 'bankDiag' : id === 'bank' || id === 'market' || current;
      return { id, status: expected ? 'missing' : 'none', bytes: 0, tables: [] };
    });
    sources.push(auditLog(db, dataDir, warnings));
    if (sources.some((s) => s.status === 'damaged')) {
      warnings.push('A part of this save could not be read and is left out. This is common when the copy was taken while the server was running.');
    }
    const folder = path.basename(dataDir) === 'data' ? path.basename(path.dirname(dataDir)) : path.basename(dataDir);
    const summary: SaveSummary = {
      path: picked, name: identity?.slaveId || folder, role, roleAssumed: !identity, serverUid: identity?.uid ?? null, masterUid: identity?.masterUid ?? null,
      knownSlaves: identity?.knownSlaves ?? null, generation: current ? 'current' : 'legacy', lastPlayedMs: level?.lastPlayedMs ?? null, minecraft: level?.version ?? null, bankVersion: files.bankVersion,
      players: files.players.length, accounts: files.accounts.length, sources, warnings,
    };
    const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    put.run('summary', JSON.stringify(summary));
    put.run('bank_audit', JSON.stringify(readBankAudit(dataDir)));
    put.run('fingerprint', print); // written last: a cache without it is incomplete and gets rebuilt
    return summary;
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

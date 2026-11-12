// First look at a save: where its data is, which server it is, which sources it has and whether they can be read.
// A save is untrusted input (DESIGN_SPEC rule 2) and is never written to (rule 1): databases are copied out
// and only the copy is opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SaveSource, SaveSummary, SaveTable } from '../../shared/api.ts';

const SOURCES: { id: SaveSource['id']; file: string }[] = [
  { id: 'bank', file: 'BankSystem/Database/banksystem.db' },
  { id: 'market', file: 'StockMarket/Database/stockdata.db' },
  { id: 'bankDiag', file: 'BankSystem/Database/banksystem_diagnostics.db' },
  { id: 'marketDiag', file: 'StockMarket/Database/stockmarket_diagnostics.db' },
];
const MOD_FOLDERS = ['BankSystem', 'StockMarket', 'ModUtilities'];
const MAX_IDENTITY_BYTES = 1_048_576;

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const isFile = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

/** The picked folder may be the world, its data folder, or any folder that holds the mod folders. */
export function findDataDir(picked: string): string {
  for (const dir of [picked, path.join(picked, 'data')]) {
    if (MOD_FOLDERS.some((m) => isDir(path.join(dir, m)))) return dir;
  }
  throw new Error('This folder holds no BankSystem or StockMarket data. Pick a world folder or its "data" folder.');
}

interface Identity { role: SaveSummary['role']; uid: string | null; slaveId: string }

function readIdentity(dataDir: string): Identity | null {
  const file = path.join(dataDir, 'ModUtilities', 'server_identity.json');
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_IDENTITY_BYTES) return null;
  try {
    const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof json !== 'object' || json === null) return null;
    const { role, server_uid, slave_id } = json as Record<string, unknown>;
    if (role !== 'MASTER' && role !== 'SLAVE' && role !== 'STANDALONE') return null;
    return { role, uid: typeof server_uid === 'string' ? server_uid : null, slaveId: typeof slave_id === 'string' ? slave_id : '' };
  } catch {
    return null; // a broken identity file is treated like a missing one, and the screen says the role was assumed
  }
}

/** Copies a database with its journal files into dir and opens the copy. The original is only ever read. */
function openCopy(file: string, dir: string): DatabaseSync {
  const copy = path.join(dir, path.basename(file));
  for (const ext of ['', '-wal', '-journal']) if (isFile(file + ext)) fs.copyFileSync(file + ext, copy + ext);
  const db = new DatabaseSync(copy);
  db.exec('PRAGMA query_only = ON');
  return db;
}

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"'; // table names come from the save

function readTables(db: DatabaseSync): SaveTable[] {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return names.map(({ name }) => {
    try {
      // NOT INDEXED: read the table itself front to back. Through an index the count can succeed on a damaged table.
      const row = db.prepare(`SELECT count(*) AS n FROM ${quote(name)} NOT INDEXED`).get() as { n: number };
      return { name, rows: row.n };
    } catch {
      return { name, rows: null };
    }
  });
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).some((c) => c.name === column);
  } catch {
    return false;
  }
}

export function openSave(picked: string): SaveSummary {
  const dataDir = findDataDir(picked);
  const identity = readIdentity(dataDir);
  const warnings: string[] = [];
  // ponytail: copies live only for this call, in the temp folder. The workspace cache of milestone M1 keeps them.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-'));
  const found = new Map<SaveSource['id'], { bytes: number; tables: SaveTable[] }>();
  let current = false; // a save of the current mods, as opposed to 2.1.2
  try {
    for (const { id, file } of SOURCES) {
      const full = path.join(dataDir, file);
      if (!isFile(full)) continue;
      let tables: SaveTable[] = [];
      try {
        const db = openCopy(full, tmp);
        try {
          tables = readTables(db);
          if (id === 'bank') current ||= hasColumn(db, 'TransactionLog', 'type_code');
          if (id === 'market') current ||= hasColumn(db, 'OrderHistory', 'order_id');
          if (id === 'bankDiag' || id === 'marketDiag') current = true; // only the current mods write diagnostics
        } finally {
          db.close();
        }
      } catch {
        tables = []; // not a database at all: reported as damaged below
      }
      found.set(id, { bytes: fs.statSync(full).size, tables });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const role = identity?.role ?? (found.has('bank') ? 'MASTER' : 'SLAVE');
  if (!identity) warnings.push('This save has no server identity file. Its role was worked out from the files that were found.');

  const sources = SOURCES.map(({ id }): SaveSource => {
    const f = found.get(id);
    if (f) {
      const damaged = f.tables.length === 0 || f.tables.some((t) => t.rows === null);
      return { id, status: damaged ? 'damaged' : 'read', bytes: f.bytes, tables: f.tables };
    }
    // What a save is expected to have: a slave keeps no bank or market data, and 2.1.2 wrote no diagnostics.
    const expected = role === 'SLAVE' ? id === 'bankDiag' : id === 'bank' || id === 'market' || current;
    return { id, status: expected ? 'missing' : 'none', bytes: 0, tables: [] };
  });
  if (sources.some((s) => s.status === 'damaged')) {
    warnings.push('A part of this save could not be read. This is common when the copy was taken while the server was running.');
  }

  const folder = path.basename(dataDir) === 'data' ? path.basename(path.dirname(dataDir)) : path.basename(dataDir);
  return {
    path: picked,
    name: identity?.slaveId || folder,
    role,
    roleAssumed: !identity,
    serverUid: identity?.uid ?? null,
    generation: current ? 'current' : 'legacy',
    sources,
    warnings,
  };
}

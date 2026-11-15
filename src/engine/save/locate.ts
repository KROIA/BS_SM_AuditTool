// Finds the mod data inside a picked folder and reads the two small files that say what the save is:
// the server identity (ModUtilities) and Minecraft's level.dat. Both are untrusted and size-limited.
import fs from 'node:fs';
import path from 'node:path';
import { big, compound, readNbt, str } from './nbt.ts';

const MOD_FOLDERS = ['BankSystem', 'StockMarket', 'ModUtilities'];
const MAX_SMALL_FILE = 64 * 1024 * 1024;

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** Reads a file only when it exists and is below the size limit. */
export function readSmallFile(file: string, max = MAX_SMALL_FILE): Buffer | null {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= max ? fs.readFileSync(file) : null;
}

/** The picked folder may be the world, its data folder, or any folder that holds the mod folders. */
export function findDataDir(picked: string): string {
  for (const dir of [picked, path.join(picked, 'data')]) {
    if (MOD_FOLDERS.some((m) => isDir(path.join(dir, m)))) return dir;
  }
  throw new Error('This folder holds no BankSystem or StockMarket data. Pick a world folder or its "data" folder.');
}

/** knownSlaves: a master's slave ids (known_slaves); null when the file does not list them. */
export interface Identity { role: 'MASTER' | 'SLAVE' | 'STANDALONE'; uid: string | null; slaveId: string; masterUid: string | null; knownSlaves: string[] | null }

export function readIdentity(dataDir: string): Identity | null {
  try {
    const file = readSmallFile(path.join(dataDir, 'ModUtilities', 'server_identity.json'));
    const json: unknown = file && JSON.parse(file.toString('utf8'));
    if (typeof json !== 'object' || json === null) return null;
    const { role, server_uid, slave_id, master_uid, known_slaves } = json as Record<string, unknown>;
    if (role !== 'MASTER' && role !== 'SLAVE' && role !== 'STANDALONE') return null;
    const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const known = typeof known_slaves === 'object' && known_slaves !== null && !Array.isArray(known_slaves)
      ? Object.keys(known_slaves).filter((k) => k.length <= 200).slice(0, 1000) : null;
    return { role, uid: text(server_uid), slaveId: text(slave_id) ?? '', masterUid: text(master_uid), knownSlaves: known };
  } catch {
    return null; // a broken identity file is treated like a missing one, and the screen says the role was assumed
  }
}

/**
 * The manifest.json of an audit export (BS-255), beside the export's data folder.
 * Untrusted: at most 1 MB, only the known fields of the expected types, never throws. null when there is none.
 * The per-file sha256 is not checked: hashing copied databases of hundreds of MB on every load is not cheap. Their sizes are.
 */
export interface Manifest {
  createdMs: number | null;
  role: Identity['role'] | null;
  uid: string | null;
  minecraft: string | null;
  bankVersion: string | null;
  marketVersion: string | null;
  /** What the manifest itself says went wrong, and files whose size differs from what it lists. */
  warnings: string[];
}
const MANIFEST_LIMIT = 1024 * 1024;
const ROLES: Record<string, Identity['role']> = { master: 'MASTER', slave: 'SLAVE', single: 'STANDALONE' };

/** reads: whether the tool reads a file (path relative to the data folder); a missing file it does not read is not worth a note. */
export function readManifest(dataDir: string, reads: (rel: string) => boolean = () => true): Manifest | null {
  if (path.basename(dataDir) !== 'data') return null;
  const root = path.dirname(dataDir);
  try {
    const file = readSmallFile(path.join(root, 'manifest.json'), MANIFEST_LIMIT);
    const json: unknown = file && JSON.parse(file.toString('utf8'));
    if (!isObject(json)) return null;
    const text = (v: unknown, max = 200) => (typeof v === 'string' && v && v.length <= max ? v : null);
    const created = text(json.created_utc, 40), ms = created === null ? NaN : Date.parse(created);
    const mods = isObject(json.mods) ? json.mods : {};
    const version = (id: string) => (Object.hasOwn(mods, id) ? text(mods[id], 64) : null);
    const role = text(json.role, 20);
    const warnings: string[] = [];
    const listed = isObject(json.participants) ? Object.entries(json.participants).filter(([id]) => id !== '__proto__').slice(0, 20) : [];
    const missing: string[] = [], differ: string[] = [];
    for (const [id, p] of listed) {
      if (!isObject(p)) continue;
      const error = text(p.error, 300);
      if (error) warnings.push(`The export of ${id.slice(0, 40)} reported a problem: ${error}`);
      for (const f of Array.isArray(p.files) ? p.files.slice(0, 2000) : []) {
        if (!isObject(f)) continue;
        const rel = text(f.path, 300);
        // Only paths inside the export: no absolute paths, no way up.
        if (rel === null || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
        if (f.method === 'missing') {
          if (reads(path.posix.relative('data', rel.replaceAll('\\', '/')))) missing.push(rel);
        }
        else if (typeof f.size === 'number') {
          const s = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
          if (!s?.isFile() || s.size !== f.size) differ.push(rel);
        }
      }
    }
    const list = (l: string[]) => l.slice(0, 3).join(', ') + (l.length > 3 ? ` and ${l.length - 3} more` : '');
    if (missing.length) warnings.push(`The server had no ${list(missing)} when it made this export.`);
    if (differ.length) warnings.push(`${list(differ)} ${differ.length === 1 ? 'is' : 'are'} missing or not the size the export lists: the copy may be incomplete.`);
    return {
      createdMs: Number.isFinite(ms) ? ms : null, role: role !== null && Object.hasOwn(ROLES, role) ? ROLES[role]! : null, uid: text(json.server_uid, 100),
      minecraft: text(json.minecraft_version, 40), bankVersion: version('banksystem'), marketVersion: version('stockmarket'), warnings,
    };
  } catch {
    return null; // a broken manifest: the folder still opens like any copy
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** When the world was last played and by which Minecraft version; null when level.dat is not part of the copy. */
export function readLevel(dataDir: string): { lastPlayedMs: number | null; version: string | null } | null {
  if (path.basename(dataDir) !== 'data') return null;
  try {
    const file = readSmallFile(path.join(path.dirname(dataDir), 'level.dat'));
    if (!file) return null;
    const data = compound(readNbt(file), 'Data');
    const played = big(data, 'LastPlayed');
    return { lastPlayedMs: played === undefined ? null : Number(played), version: str(compound(data, 'Version'), 'Name') ?? null };
  } catch {
    return null;
  }
}

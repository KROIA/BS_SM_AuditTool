// Finds the mod data inside a picked folder and reads the two small files that say what the save is:
// the server identity (ModUtilities) and Minecraft's level.dat. Both are untrusted and size-limited.
import fs from 'node:fs';
import path from 'node:path';
import { big, compound, readNbt, str } from './nbt.ts';

const MOD_FOLDERS = ['BankSystem', 'StockMarket', 'ModUtilities'];
const MAX_SMALL_FILE = 64 * 1024 * 1024;

const isDir = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

/** Reads a file only when it exists and is below the size limit. */
export function readSmallFile(file: string): Buffer | null {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= MAX_SMALL_FILE ? fs.readFileSync(file) : null;
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

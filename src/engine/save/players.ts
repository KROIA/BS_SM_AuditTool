// Reads the player files of a world (playerdata/<uuid>.dat): what each player carries in the inventory and the ender
// chest, into nested containers (shulker boxes, bundles). Money items are valued; every other stack is kept by name, and
// the query decides which of them are valuables (they need the master's market list, which a slave's save does not have).
// The files are untrusted: a file that breaks a limit is skipped whole and counted, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { readSmallFile } from './locate.ts';
import { compound, isCompound, list, num, readNbt, str, type Nbt } from './nbt.ts';

export const LIMITS = {
  fileBytes: 16 * 1024 * 1024,
  unpacked: 32 * 1024 * 1024,
  /** Containers inside containers: a shulker box in the ender chest is level 1. */
  depth: 8,
  /** Stacks walked in one file, at every level. */
  stacks: 20_000,
  /** Different stacks kept per save (rows of the cache); files after it are not read. */
  rows: 200_000,
  files: 100_000,
};
const NAME = 200; // longest item id kept

const DENOMINATION = /^banksystem:money(_cent)?(\d{1,7})$/;
/**
 * What one money item of this registry name is worth, raw; null for any other item. BS MoneyItem*.java worth():
 * banksystem:money 100, banksystem:money<N> N x 100, banksystem:money_cent<N> N. The bank only takes a stack without
 * components (MoneyItem.isMoney, isSameItemSameComponents with the plain stack); the caller checks that.
 */
export function worthOf(name: string): bigint | null {
  if (name === 'banksystem:money') return 100n;
  const m = DENOMINATION.exec(name);
  return m ? BigInt(m[2]!) * (m[1] ? 1n : 100n) : null;
}

export type Place = 'inventory' | 'ender chest';
/**
 * Stacks of one item at one place, added up. path: the containers it is in, outermost first (item ids). plain: no
 * components (1.20.5+) and no tag (older saves). worth: raw value of one piece for a plain money item, else null.
 */
export interface Stack { player: string; place: Place; path: string[]; item: string; count: number; plain: boolean; worth: bigint | null }
/** ok false: the file could not be read (damaged, not NBT, a limit broken) or was left out because the save hit the row limit. */
export interface PlayerFiles { files: { uuid: string; ok: boolean }[]; stacks: Stack[]; bad: number; skipped: number }

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.dat$/i;

/** One stack as the walker meets it; path: the containers it is in, outermost first. */
export interface Found { path: string[]; item: string; count: number; plain: boolean; worth: bigint | null }

/**
 * Walks a list of stacks and the containers inside them (1.20.5+ components and the older tag layout) and calls add per
 * stack. budget: the stacks left for one file or container, shared between calls. Throws a sentence when a limit is broken.
 */
export function walkStacks(entries: Nbt[], at: string[], add: (s: Found) => void, budget = { left: LIMITS.stacks }): void {
  for (const e of entries.filter(isCompound)) {
    // A 1.20.5+ container lists { slot, item }; inventories, bundles and older containers list the stack itself.
    const stack = str(e, 'id') === undefined ? compound(e, 'item') : e;
    const id = str(stack, 'id'), count = num(stack, 'count') ?? num(stack, 'Count');
    if (!id || count === undefined || !Number.isInteger(count) || count <= 0) continue;
    if (--budget.left < 0) throw new Error(`more than ${LIMITS.stacks} stacks`);
    const item = id.slice(0, NAME), parts = compound(stack, 'components'), tag = compound(stack, 'tag');
    const plain = Object.keys(parts ?? {}).length === 0 && Object.keys(tag ?? {}).length === 0;
    add({ path: at, item, count, plain, worth: plain ? worthOf(item) : null });
    const inner = [...list(parts, 'minecraft:container'), ...list(parts, 'minecraft:bundle_contents'), // 1.20.5+
      ...list(compound(tag, 'BlockEntityTag'), 'Items'), ...list(tag, 'Items')]; // older: shulker boxes, bundles
    if (!inner.length) continue;
    if (at.length >= LIMITS.depth) throw new Error(`containers nested deeper than ${LIMITS.depth} levels`);
    walkStacks(inner, [...at, item], add, budget);
  }
}

/** One player file's stacks; throws a sentence when a limit is broken. */
export function readPlayer(nbt: { [k: string]: Nbt }, player: string): Stack[] {
  const out = new Map<string, Stack>();
  const budget = { left: LIMITS.stacks };
  const at = (place: Place) => (f: Found) => {
    const key = JSON.stringify([place, f.path, f.item, f.plain]);
    const s = out.get(key) ?? out.set(key, { player, place, ...f, count: 0 }).get(key)!;
    s.count += f.count;
  };
  walkStacks(list(nbt, 'Inventory'), [], at('inventory'), budget);
  walkStacks(list(nbt, 'EnderItems'), [], at('ender chest'), budget);
  return [...out.values()];
}

/** Every <uuid>.dat in the folder (.dat_old and other names are left out); nothing when there is no such folder. */
export function readPlayerFiles(dir: string): PlayerFiles {
  const out: PlayerFiles = { files: [], stacks: [], bad: 0, skipped: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => UUID_FILE.test(n)).sort().slice(0, LIMITS.files);
  } catch {
    return out;
  }
  for (const name of names) {
    const uuid = UUID_FILE.exec(name)![1]!.toLowerCase();
    if (out.stacks.length >= LIMITS.rows) {
      out.files.push({ uuid, ok: false });
      out.skipped++;
      continue;
    }
    try {
      const file = readSmallFile(path.join(dir, name), LIMITS.fileBytes);
      if (!file) throw new Error('missing or too large');
      const stacks = readPlayer(readNbt(file, LIMITS.unpacked), uuid);
      out.stacks.push(...stacks.slice(0, LIMITS.rows - out.stacks.length));
      out.files.push({ uuid, ok: true });
    } catch {
      out.files.push({ uuid, ok: false });
      out.bad++;
    }
  }
  return out;
}

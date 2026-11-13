// Reads Minecraft's Anvil region files (r.<x>.<z>.mca) and finds money and valuables in the chunks:
// block entities (chests, barrels, the BankSystem blocks) in region/, entities (dropped items, minecarts, villagers' offers)
// in entities/. The files are untrusted: every offset, length and size is checked, and a chunk that
// breaks one is counted and skipped, never fatal. Runs in the scan's worker threads (region-worker.ts).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { compound, isCompound, list, num, readNbt, str, uuidFromInts, type Nbt, type NbtCompound } from './nbt.ts';
import { LIMITS as STACK_LIMITS, walkStacks, worthOf, type Found } from './players.ts';

export const REGION_LIMITS = {
  /** A chunk's data in the region file: the format allows at most 255 sectors of 4 KiB. */
  sector: 4096,
  /** A chunk kept in its own c.<x>.<z>.mcc file (too large for 255 sectors). */
  external: 64 * 1024 * 1024,
  /** One chunk unpacked. */
  unpacked: 64 * 1024 * 1024,
  /** Riders on riders (a villager in a boat on ...). */
  passengers: 8,
};

/** What could not be read, in chunks: damaged (offsets, lengths, packing or NBT broken), LZ4-packed (not read), too large. */
export interface ChunkCounts { chunks: number; damaged: number; lz4: number; tooLarge: number }

/**
 * Something of value at one place, added up per place, path and item. source: block (a block entity), entity, or offer
 * (a villager's or trader's offer: a price, not a note that exists). owner: the player of a bank terminal's inventory;
 * account: the account an upload or download block is bound to.
 */
export interface Find extends Found { x: number; y: number; z: number; place: string; source: 'block' | 'entity' | 'offer'; owner: string | null; account: number | null }

const DISPLAY = 'banksystem:banksystem_display_block_entity'; // its stacks are icons, not items
const STOCKPILE = 'banksystem:money_stockpile_block_entity';
const TERMINAL = 'banksystem:bank_terminal_block_entity';
const UPLOAD = 'banksystem:bank_upload_block_entity';
const DOWNLOAD = 'banksystem:bank_download_block_entity';

class TooLarge extends Error {}

/** One chunk's NBT from the bytes read for it; throws TooLarge, or another error when it is damaged, or 'lz4'. */
function chunkNbt(buf: Buffer, file: string, index: number): NbtCompound {
  const length = buf.readUInt32BE(0), type = buf[4]!;
  if (length < 1 || length > buf.length - 4) throw new Error('length past its sectors');
  let data = buf.subarray(5, 4 + length);
  if (type & 128) { // kept in c.<x>.<z>.mcc beside the region file
    const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(path.basename(file))!;
    const cx = Number(m[1]) * 32 + (index & 31), cz = Number(m[2]) * 32 + (index >> 5);
    const ext = path.join(path.dirname(file), `c.${cx}.${cz}.mcc`);
    const size = fs.statSync(ext).size; // missing: damaged
    if (size > REGION_LIMITS.external) throw new TooLarge();
    data = fs.readFileSync(ext);
  }
  const packing = type & 127;
  if (packing === 4) throw new Error('lz4');
  if (packing < 1 || packing > 3) throw new Error('unknown packing');
  let raw: Buffer;
  try {
    const opts = { maxOutputLength: REGION_LIMITS.unpacked };
    raw = packing === 1 ? zlib.gunzipSync(data, opts) : packing === 2 ? zlib.inflateSync(data, opts) : data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new TooLarge();
    throw e;
  }
  if (raw.length > REGION_LIMITS.unpacked) throw new TooLarge();
  if (raw[0] !== 10) throw new Error('not NBT'); // a raw NBT root; readNbt would otherwise try to unpack it again
  return readNbt(raw, REGION_LIMITS.unpacked);
}

/**
 * Reads every chunk of one region file and hands its NBT to onChunk. Throws only when the file itself cannot be read
 * (missing, shorter than its 8 KiB header); a broken chunk, or one whose onChunk breaks a limit, is counted.
 */
export function readRegion(file: string, onChunk: (nbt: NbtCompound) => void): ChunkCounts {
  const out: ChunkCounts = { chunks: 0, damaged: 0, lz4: 0, tooLarge: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return out; // Minecraft leaves empty region files behind
    if (size < 2 * REGION_LIMITS.sector) throw new Error('shorter than its header');
    const header = Buffer.alloc(REGION_LIMITS.sector);
    fs.readSync(fd, header, 0, header.length, 0);
    for (let i = 0; i < 1024; i++) {
      const entry = header.readUInt32BE(i * 4);
      if (entry === 0) continue; // no chunk here
      const offset = entry >>> 8, sectors = entry & 0xff;
      try {
        if (offset < 2 || sectors === 0 || offset * REGION_LIMITS.sector >= size) throw new Error('outside the file');
        // Minecraft pads the file's last sector only when it closes the file: a copy of a running server's world can end
        // inside its last chunk, with the chunk's data all there. The length check in chunkNbt decides.
        const buf = Buffer.alloc(Math.min(sectors * REGION_LIMITS.sector, size - offset * REGION_LIMITS.sector));
        fs.readSync(fd, buf, 0, buf.length, offset * REGION_LIMITS.sector);
        onChunk(chunkNbt(buf, file, i));
        out.chunks++;
      } catch (e) {
        if (e instanceof TooLarge || (e instanceof Error && /^more than|nested deeper/.test(e.message))) out.tooLarge++;
        else if (e instanceof Error && e.message === 'lz4') out.lz4++;
        else out.damaged++;
      }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What one chunk holds. keep: whether a stack is worth recording (money, or a valuable). moneyName: the main save's name
 * for an item number, for the money stockpile, which keeps numbers instead of stacks.
 */
export function findInChunk(nbt: NbtCompound, keep: (f: Found) => boolean, moneyName: (id: number) => string | undefined, add: (f: Find) => void) {
  const level = compound(nbt, 'Level'); // a chunk not loaded since before 1.18 keeps the old layout
  for (const be of [...list(nbt, 'block_entities'), ...list(level, 'TileEntities')].filter(isCompound)) {
    const place = str(be, 'id') ?? '', x = num(be, 'x'), y = num(be, 'y'), z = num(be, 'z');
    if (place === DISPLAY || x === undefined || y === undefined || z === undefined) continue;
    const at = { x, y, z, place: place.slice(0, 200), source: 'block' as const, owner: null, account: null };
    const put = (where: Omit<Find, keyof Found>) => (f: Found) => { if (keep(f)) add({ ...where, ...f }); };
    const budget = { left: STACK_LIMITS.stacks };
    if (place === STOCKPILE) {
      // Entries { id: short, amount: int }: notes by the master's item number.
      for (const e of list(be, 'items').filter(isCompound)) {
        const id = num(e, 'id'), amount = num(e, 'amount');
        if (id === undefined || amount === undefined || !Number.isInteger(amount) || amount <= 0) continue;
        const item = moneyName(id) ?? `#${id}`; // a number the item list does not know: kept, of unknown value
        add({ ...at, path: [], item, count: amount, plain: true, worth: worthOf(item) });
      }
    } else if (place === TERMINAL) {
      for (const p of list(compound(be, 'banksystem'), 'PlayerData').filter(isCompound)) {
        const stacks = list(compound(p, 'Inventory'), 'Slots').filter(isCompound).map((s) => compound(s, 'ItemStack')).filter((s) => s !== undefined);
        walkStacks(stacks, [], put({ ...at, owner: uuidFromInts(p.PlayerID) ?? null }), budget);
      }
    } else if (place === DOWNLOAD) {
      walkStacks(be.I === undefined ? list(be, 'Items') : list(be, 'I'), [], put({ ...at, account: num(be, 'A') ?? null }), budget);
    } else {
      // Every container with an Items list (chests, barrels, shulker boxes, hoppers, the upload block, the share stamper),
      // and the one item of a decorated pot.
      const account = place === UPLOAD ? num(be, 'BankAccountNumber') ?? null : null;
      walkStacks([...list(be, 'Items'), ...[compound(be, 'item')].filter((s) => s !== undefined)], [], put({ ...at, account }), budget);
    }
  }
  for (const e of [...list(nbt, 'Entities'), ...list(level, 'Entities')]) entity(e, 0, keep, add);
}

function entity(e: Nbt, depth: number, keep: (f: Found) => boolean, add: (f: Find) => void) {
  if (!isCompound(e) || depth > REGION_LIMITS.passengers) return;
  const pos = list(e, 'Pos');
  const [x, y, z] = pos.map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN));
  if (pos.length !== 3 || [x, y, z].some((v) => !Number.isSafeInteger(v))) return;
  const at = { x: x!, y: y!, z: z!, place: (str(e, 'id') ?? '').slice(0, 200), owner: null, account: null };
  const budget = { left: STACK_LIMITS.stacks };
  const put = (source: Find['source']) => (f: Found) => { if (keep(f)) add({ ...at, source, ...f }); };
  const one = (name: string) => [compound(e, name)].filter((s) => s !== undefined);
  // Dropped items and item frames (Item), chest minecarts, chest boats, donkeys and llamas (Items), allays and villagers
  // (Inventory), armor stands and other mobs (HandItems, ArmorItems).
  walkStacks([...one('Item'), ...list(e, 'Items'), ...list(e, 'Inventory'), ...list(e, 'HandItems'), ...list(e, 'ArmorItems')], [], put('entity'), budget);
  for (const r of list(compound(e, 'Offers'), 'Recipes').filter(isCompound)) {
    walkStacks(['buy', 'buyB', 'sell'].flatMap((k) => [compound(r, k)].filter((s) => s !== undefined)), [], put('offer'), budget);
  }
  for (const p of list(e, 'Passengers')) entity(p, depth + 1, keep, add);
}

/** One region file's finds, added up per place, path and item, with its chunk counts. */
export function scanRegion(file: string, keep: (f: Found) => boolean, moneyName: (id: number) => string | undefined): ChunkCounts & { finds: Find[] } {
  const finds = new Map<string, Find>();
  const counts = readRegion(file, (nbt) => {
    const mine: Find[] = []; // a chunk that breaks a limit adds nothing
    findInChunk(nbt, keep, moneyName, (f) => mine.push(f));
    for (const f of mine) {
      const key = JSON.stringify([f.x, f.y, f.z, f.place, f.source, f.owner, f.account, f.path, f.item, f.plain]);
      const had = finds.get(key);
      if (had) had.count += f.count;
      else finds.set(key, { ...f });
    }
  });
  return { ...counts, finds: [...finds.values()] };
}

// Reader for Minecraft's NBT format, for files that come out of a save and are therefore untrusted
// (DESIGN_SPEC section 4.4): the unpacked size, the nesting depth and every length are checked against limits.
import zlib from 'node:zlib';

export type Nbt = number | bigint | string | Nbt[] | NbtCompound | Int8Array | Int32Array | BigInt64Array;
export interface NbtCompound { [name: string]: Nbt }

const MAX_UNPACKED = 256 * 1024 * 1024;
const MAX_DEPTH = 512;

/** Unpacks (gzip or zlib, when packed) and reads one NBT file. Throws a plain sentence when the data is not valid. */
export function readNbt(file: Buffer, maxUnpacked = MAX_UNPACKED): NbtCompound {
  let buf = file;
  try {
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: maxUnpacked });
    else if (buf[0] === 0x78) buf = zlib.inflateSync(buf, { maxOutputLength: maxUnpacked });
  } catch {
    throw new Error(`The file could not be unpacked, or it unpacks to more than ${maxUnpacked / 1024 / 1024} MB.`);
  }
  try {
    return parse(buf);
  } catch (e) {
    throw new Error('The file is not valid NBT data' + (e instanceof Error && e.message.startsWith('NBT') ? ': ' + e.message : '.'));
  }
}

function parse(buf: Buffer): NbtCompound {
  let p = 0;
  const text = new TextDecoder('utf-8');
  const need = (n: number) => { if (n < 0 || p + n > buf.length) throw new Error('NBT ends in the middle of a value'); };
  const string = () => { const n = buf.readUInt16BE(p); p += 2; need(n); const s = text.decode(buf.subarray(p, p + n)); p += n; return s; };
  const length = (bytesEach: number) => { const n = buf.readInt32BE(p); p += 4; need(n * bytesEach); return n; };

  const value = (type: number, depth: number): Nbt => {
    if (depth > MAX_DEPTH) throw new Error('NBT is nested deeper than 512 levels');
    switch (type) {
      case 1: return buf.readInt8(p++);
      case 2: p += 2; return buf.readInt16BE(p - 2);
      case 3: p += 4; return buf.readInt32BE(p - 4);
      case 4: p += 8; return buf.readBigInt64BE(p - 8);
      case 5: p += 4; return buf.readFloatBE(p - 4);
      case 6: p += 8; return buf.readDoubleBE(p - 8);
      case 7: { const n = length(1); const a = new Int8Array(buf.subarray(p, p + n)); p += n; return a; }
      case 8: return string();
      case 9: {
        const of = buf.readUInt8(p++), n = length(of === 0 ? 0 : 1); // every element takes at least one byte
        const list: Nbt[] = [];
        for (let i = 0; i < n; i++) list.push(value(of, depth + 1));
        return list;
      }
      case 10: {
        const c: NbtCompound = Object.create(null); // no inherited names: a tag may be called "constructor"
        for (;;) {
          const t = buf.readUInt8(p++);
          if (t === 0) return c;
          const name = string();
          c[name] = value(t, depth + 1);
        }
      }
      case 11: { const n = length(4); const a = new Int32Array(n); for (let i = 0; i < n; i++, p += 4) a[i] = buf.readInt32BE(p); return a; }
      case 12: { const n = length(8); const a = new BigInt64Array(n); for (let i = 0; i < n; i++, p += 8) a[i] = buf.readBigInt64BE(p); return a; }
      default: throw new Error('NBT has an unknown tag type ' + type);
    }
  };

  if (buf.readUInt8(p++) !== 10) throw new Error('NBT does not start with a compound');
  string(); // the root's name, always empty in practice
  return value(10, 0) as NbtCompound;
}

// Typed access to values from a save. Each returns undefined when the tag is missing or of another type,
// so that a strange file leads to "not found" and never to a crash.
export const isCompound = (v: Nbt | undefined): v is NbtCompound =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v);
export const compound = (c: NbtCompound | undefined, name: string) => { const v = c?.[name]; return isCompound(v) ? v : undefined; };
export const list = (c: NbtCompound | undefined, name: string): Nbt[] => { const v = c?.[name]; return Array.isArray(v) ? v : []; };
export const str = (c: NbtCompound | undefined, name: string) => { const v = c?.[name]; return typeof v === 'string' ? v : undefined; };
export const num = (c: NbtCompound | undefined, name: string) => { const v = c?.[name]; return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined; };
export const big = (c: NbtCompound | undefined, name: string) => { const v = c?.[name]; return typeof v === 'bigint' ? v : typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : undefined; };
export const flag = (c: NbtCompound | undefined, name: string) => num(c, name) === 1;

/** A UUID stored as four ints (Minecraft's usual form) as text: a1b2c3d4-e5f6-4a7b-8c9d-000000000001 */
export function uuidFromInts(v: Nbt | undefined): string | undefined {
  if (!(v instanceof Int32Array) || v.length !== 4) return undefined;
  const hex = Array.from(v, (n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A UUID stored as two 64-bit halves (as in OrderHistory) as text. */
export function uuidFromHalves(high: bigint, low: bigint): string {
  const hex = BigInt.asUintN(64, high).toString(16).padStart(16, '0') + BigInt.asUintN(64, low).toString(16).padStart(16, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

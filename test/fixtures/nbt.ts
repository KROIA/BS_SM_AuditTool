// Writer for NBT, used only to build test files. Values carry their NBT type, because a JS number alone does not say
// whether it is a byte, a short or an int.
import zlib from 'node:zlib';

export type Tag =
  | { t: 1 | 2 | 3; v: number } // byte, short, int
  | { t: 4; v: bigint }
  | { t: 5 | 6; v: number } // float, double
  | { t: 8; v: string }
  | { t: 9; of: number; v: Tag[] }
  | { t: 10; v: Record<string, Tag> }
  | { t: 11; v: number[] };

export const byte = (v: number | boolean): Tag => ({ t: 1, v: Number(v) });
export const short = (v: number): Tag => ({ t: 2, v });
export const int = (v: number): Tag => ({ t: 3, v });
export const long = (v: bigint | number): Tag => ({ t: 4, v: BigInt(v) });
export const float = (v: number): Tag => ({ t: 5, v });
export const double = (v: number): Tag => ({ t: 6, v });
export const str = (v: string): Tag => ({ t: 8, v });
export const comp = (v: Record<string, Tag>): Tag => ({ t: 10, v });
/** A list; `of` is the element type and is taken from the first element when left out (10 for an empty list). */
export const list = (v: Tag[], of = v[0]?.t ?? 10): Tag => ({ t: 9, of, v });
export const ints = (v: number[]): Tag => ({ t: 11, v });
/** A UUID as Minecraft stores it: four ints. */
export const uuid = (text: string): Tag => {
  const hex = text.replaceAll('-', '');
  return ints([0, 8, 16, 24].map((i) => Number.parseInt(hex.slice(i, i + 8), 16) | 0));
};

function payload(tag: Tag, out: Buffer[]) {
  const b = (n: number) => Buffer.alloc(n);
  switch (tag.t) {
    case 1: { const x = b(1); x.writeInt8(tag.v); out.push(x); break; }
    case 2: { const x = b(2); x.writeInt16BE(tag.v); out.push(x); break; }
    case 3: { const x = b(4); x.writeInt32BE(tag.v); out.push(x); break; }
    case 4: { const x = b(8); x.writeBigInt64BE(tag.v); out.push(x); break; }
    case 5: { const x = b(4); x.writeFloatBE(tag.v); out.push(x); break; }
    case 6: { const x = b(8); x.writeDoubleBE(tag.v); out.push(x); break; }
    case 8: out.push(name(tag.v)); break;
    case 9: { const x = b(5); x.writeUInt8(tag.v.length ? tag.of : 0); x.writeInt32BE(tag.v.length, 1); out.push(x); for (const e of tag.v) payload(e, out); break; }
    case 10: for (const [k, v] of Object.entries(tag.v)) { out.push(Buffer.from([v.t]), name(k)); payload(v, out); } out.push(Buffer.from([0])); break;
    case 11: { const x = b(4 + 4 * tag.v.length); x.writeInt32BE(tag.v.length); tag.v.forEach((n, i) => x.writeInt32BE(n, 4 + 4 * i)); out.push(x); break; }
  }
}
function name(s: string): Buffer {
  const text = Buffer.from(s, 'utf8'), len = Buffer.alloc(2);
  len.writeUInt16BE(text.length);
  return Buffer.concat([len, text]);
}

/** A complete NBT file: unnamed root compound, gzip-packed as Minecraft writes it. */
export function nbtFile(root: Record<string, Tag>, packed = true): Buffer {
  const out: Buffer[] = [Buffer.from([10]), name('')];
  payload(comp(root), out);
  const raw = Buffer.concat(out);
  return packed ? zlib.gzipSync(raw) : raw;
}

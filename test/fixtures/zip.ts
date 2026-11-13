// A small zip writer for the tests: stored or deflated entries, zip64 on request, and the broken kinds a zip can come in
// (a declared size or checksum that lies, a flag or method the reader must refuse, a link, a name in code page 437).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  data?: Buffer;
  /** 0 stored, 8 deflate; any other number writes the data as it is under that method. */
  method?: number;
  /** Added to the UTF-8 flag (bit 11), e.g. 1 for "encrypted". */
  flags?: number;
  /** What the headers declare, when it should not be the truth. */
  crc?: number;
  size?: number;
  /** A Unix symbolic link. */
  link?: boolean;
  /** The name's bytes as they are, without the UTF-8 flag (code page 437). */
  raw?: Buffer;
}

const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

export function zipBuffer(entries: ZipEntry[], zip64 = false): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? (data.length ? 8 : 0);
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = e.raw ?? Buffer.from(e.name, 'utf8'), flags = (e.flags ?? 0) | (e.raw ? 0 : 0x800);
    const crc = e.crc ?? zlib.crc32(data), size = e.size ?? data.length;
    const big = (v: number) => (zip64 ? 0xffffffff : v);
    const localExtra = zip64 ? Buffer.concat([u16(1), u16(16), u64(size), u64(packed.length)]) : Buffer.alloc(0);
    const local = Buffer.concat([u32(0x04034b50), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
      u32(big(packed.length)), u32(big(size)), u16(name.length), u16(localExtra.length), name, localExtra]);
    const extra = zip64 ? Buffer.concat([u16(1), u16(24), u64(size), u64(packed.length), u64(at)]) : Buffer.alloc(0);
    central.push(Buffer.concat([u32(0x02014b50), u16(e.link ? 0x031e : 0x0014), u16(zip64 ? 45 : 20), u16(flags), u16(method), u16(0), u16(0x21), u32(crc),
      u32(big(packed.length)), u32(big(size)), u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(e.link ? 0o120777 << 16 : 0), u32(big(at)), name, extra]));
    parts.push(local, packed);
    at += local.length + packed.length;
  }
  const dir = Buffer.concat(central), n = entries.length;
  const tail: Buffer[] = [];
  if (zip64) {
    tail.push(Buffer.concat([u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0), u64(n), u64(n), u64(dir.length), u64(at)]));
    tail.push(Buffer.concat([u32(0x07064b50), u32(0), u64(at + dir.length), u32(1)]));
  }
  tail.push(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(zip64 ? 0xffff : n), u16(zip64 ? 0xffff : n), u32(zip64 ? 0xffffffff : dir.length), u32(zip64 ? 0xffffffff : at), u16(0)]));
  return Buffer.concat([...parts, dir, ...tail]);
}

export function writeZip(file: string, entries: ZipEntry[], zip64 = false): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zipBuffer(entries, zip64));
  return file;
}

/** The entries of a folder, folders included as Explorer writes them, under prefix ("" or "top/"). */
export function folderEntries(dir: string, prefix = ''): ZipEntry[] {
  const out: ZipEntry[] = prefix ? [{ name: prefix }] : [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...folderEntries(full, `${prefix}${d.name}/`));
    else out.push({ name: prefix + d.name, data: fs.readFileSync(full) });
  }
  return out;
}

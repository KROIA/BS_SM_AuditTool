// Unpacks a .zip (an audit export package or a zipped world folder) into a folder of the workspace, so it opens like a
// picked folder. A zip is save data and untrusted: names that lead out of the folder, links, encrypted entries, unknown
// methods and bombs are refused one entry at a time, each with one sentence; sizes are counted while inflating, never
// taken from the headers. A damaged or cut-off zip unpacks what is readable and lists the rest. The zip is only read.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { bytes, count } from '../../shared/fmt.ts';

const MB = 1024 * 1024;
/**
 * entries: at most this many in one zip. total: unpacked bytes over all entries; the largest real input so far is a world
 * copy of 2 GB (its data folder, which is what an export package holds, is 0.7 GB), so 8 GB is about 4 times it.
 * A single entry that passes `after` bytes and `ratio` times its packed size is stopped. Tests lower them.
 */
export const ZIP_LIMITS = { entries: 20_000, total: 8 * 1024 * MB, ratio: 200, after: 100 * MB };
const DIRECTORY_LIMIT = 64 * MB; // the table of contents of 20'000 entries is a few MB

// The upper half of code page 437, which zips use for names without the UTF-8 flag.
export const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const cp437 = (b: Buffer) => [...b].map((c) => (c < 128 ? String.fromCharCode(c) : CP437[c - 128])).join('');

interface Entry { name: string; flags: number; method: number; crc: number; packed: number; size: number; local: number; link: boolean }
/** What was not unpacked, entry by entry, in one sentence each. entry: the name inside the zip, empty for the zip as a whole. */
export interface ZipProblem { entry: string; text: string }

/** A u64 field as a number; above 2^53 it is not a size any zip of a save can have. */
const u64 = (b: Buffer, at: number) => {
  const v = b.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('a size field is out of range');
  return Number(v);
};
const shown = (name: string) => `"${name.replace(/[\u0000-\u001f]/g, '?').slice(0, 200)}"`;

async function readAt(fh: fs.promises.FileHandle, at: number, length: number): Promise<Buffer> {
  const b = Buffer.alloc(length);
  const { bytesRead } = await fh.read(b, 0, length, at);
  return b.subarray(0, bytesRead);
}

/** The zip64 extra field (0x0001): the values that are 0xFFFFFFFF in the fixed fields, in this order. */
function zip64(extra: Buffer, e: { size: number; packed: number; local: number }) {
  for (let i = 0; i + 4 <= extra.length;) {
    const id = extra.readUInt16LE(i), len = extra.readUInt16LE(i + 2);
    if (id === 1) {
      let at = i + 4;
      for (const k of ['size', 'packed', 'local'] as const) {
        if (e[k] !== 0xffffffff) continue;
        if (at + 8 > i + 4 + len) break;
        e[k] = u64(extra, at);
        at += 8;
      }
    }
    i += 4 + len;
  }
}
const nameOf = (raw: Buffer, flags: number) => (flags & 0x800 ? raw.toString('utf8') : cp437(raw));

/** The entries from the table of contents at the end; null when there is none (a cut-off zip). */
async function directory(fh: fs.promises.FileHandle, size: number, problems: ZipProblem[]): Promise<Entry[] | null> {
  const tailAt = Math.max(0, size - 65_557), tail = await readAt(fh, tailAt, size - tailAt);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) return null;
  let entries = tail.readUInt16LE(end + 10), dirSize = tail.readUInt32LE(end + 12), dirAt = tail.readUInt32LE(end + 16);
  // Zip64: the locator sits right before the end record and points at the zip64 end record.
  if (end >= 20 && tail.readUInt32LE(end - 20) === 0x07064b50) {
    const rec = await readAt(fh, u64(tail, end - 12), 56);
    if (rec.length < 56 || rec.readUInt32LE(0) !== 0x06064b50) throw new Error('its zip64 end record is damaged');
    entries = u64(rec, 32);
    dirSize = u64(rec, 40);
    dirAt = u64(rec, 48);
  }
  if (entries > ZIP_LIMITS.entries) throw new Error(`it lists ${count(entries)} files, more than the ${count(ZIP_LIMITS.entries)} the tool unpacks`);
  if (dirSize > DIRECTORY_LIMIT) throw new Error('its table of contents is larger than any save would need');
  const dir = await readAt(fh, dirAt, dirSize);
  const out: Entry[] = [];
  for (let i = 0; out.length < entries; ) {
    if (i + 46 > dir.length || dir.readUInt32LE(i) !== 0x02014b50) {
      problems.push({ entry: '', text: `The zip's table of contents is damaged after ${count(out.length)} of ${count(entries)} files. The rest was not unpacked.` });
      break;
    }
    const flags = dir.readUInt16LE(i + 8), n = dir.readUInt16LE(i + 28), x = dir.readUInt16LE(i + 30), c = dir.readUInt16LE(i + 32);
    const e: Entry = {
      name: nameOf(dir.subarray(i + 46, i + 46 + n), flags), flags, method: dir.readUInt16LE(i + 10), crc: dir.readUInt32LE(i + 16),
      packed: dir.readUInt32LE(i + 20), size: dir.readUInt32LE(i + 24), local: dir.readUInt32LE(i + 42),
      // Made on Unix (high byte 3): the file type is in the upper half of the external attributes.
      link: dir.readUInt8(i + 5) === 3 && ((dir.readUInt32LE(i + 38) >>> 16) & 0o170000) === 0o120000,
    };
    zip64(dir.subarray(i + 46 + n, i + 46 + n + x), e);
    out.push(e);
    i += 46 + n + x + c;
  }
  return out;
}

/** Without a table of contents: the entries one after the other from the start, as far as their headers give their sizes. */
async function walk(fh: fs.promises.FileHandle, size: number, problems: ZipProblem[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (let at = 0; at + 30 <= size;) {
    const h = await readAt(fh, at, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) break;
    if (out.length >= ZIP_LIMITS.entries) throw new Error(`it holds more than the ${count(ZIP_LIMITS.entries)} files the tool unpacks`);
    const flags = h.readUInt16LE(6), n = h.readUInt16LE(26), x = h.readUInt16LE(28), more = await readAt(fh, at + 30, n + x);
    const e: Entry = { name: nameOf(more.subarray(0, n), flags), flags, method: h.readUInt16LE(8), crc: h.readUInt32LE(14), packed: h.readUInt32LE(18), size: h.readUInt32LE(22), local: at, link: false };
    zip64(more.subarray(n), e);
    // ponytail: an entry with a data descriptor and no sizes in its header ends the walk; inflating to find its end would read on.
    if (flags & 8 && e.packed === 0) {
      problems.push({ entry: e.name, text: `${shown(e.name)} and what follows it were not unpacked: the zip is cut off and this entry does not say how long it is.` });
      break;
    }
    out.push(e);
    at += 30 + n + x + e.packed;
  }
  return out;
}

const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** The path parts of a name, or why it is refused. */
function parts(name: string): string[] | string {
  if (name.includes('\0')) return 'its name holds a null character';
  if (/^[\\/]{2}/.test(name)) return 'its name is a network path';
  if (/^[\\/]/.test(name)) return 'its name is an absolute path';
  if (/^[a-z]:/i.test(name)) return 'its name starts with a drive letter';
  if (name.includes(':')) return 'its name holds a ":", which Windows reads as a hidden data stream';
  const segs = name.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) return 'its name leads out of the folder';
  // Windows drops a trailing dot or space from a name part, so ".. " would become ".." on disk.
  if (segs.some((s) => /[. ]$/.test(s))) return 'a part of its name ends in a dot or a space, which Windows drops';
  const bad = segs.find((s) => RESERVED.test(s.split('.')[0]!.trimEnd()));
  if (bad) return `its name uses "${bad}", which Windows reserves for a device`;
  return segs.length ? segs : 'its name is empty';
}

export interface Unzipped { bytes: number; problems: ZipProblem[] }

/**
 * Unpacks file into dest (which must not exist yet, or be empty). progress gets the bytes unpacked and the size the zip
 * declares. Throws, with the reason in words, when the zip cannot be opened at all or passes a limit of the whole zip
 * (count, total, disk space); dest may then hold part of it, and the caller removes it.
 */
export async function unzip(file: string, dest: string, progress: (done: number, total: number) => void = () => {}): Promise<Unzipped> {
  const problems: ZipProblem[] = [];
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const entries = (await directory(fh, size, problems)) ?? await walk(fh, size, problems);
    if (!entries.length && !problems.length) throw new Error('it is not a zip, or it is empty');
    if (!entries.length) throw new Error(problems[0]!.text);
    const declared = entries.reduce((s, e) => s + e.size, 0);
    fs.mkdirSync(dest, { recursive: true });
    const free = (() => { const s = fs.statfsSync(dest); return s.bavail * s.bsize; })();
    if (declared > free) throw new Error(`it unpacks to ${bytes(declared)}, and the disk has only ${bytes(free)} free`);
    const root = path.resolve(dest);

    let total = 0, told = 0;
    for (const e of entries) {
      const refuse = (why: string) => problems.push({ entry: e.name, text: `${shown(e.name)} was not unpacked: ${why}.` });
      const segs = parts(e.name);
      if (typeof segs === 'string') { refuse(segs); continue; }
      const target = path.join(root, ...segs), rel = path.relative(root, target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { refuse('its name leads out of the folder'); continue; }
      if (/[\\/]$/.test(e.name)) { fs.mkdirSync(target, { recursive: true }); continue; }
      if (e.link) { refuse('it is a link, and links are skipped'); continue; }
      if (e.flags & 1) { refuse('it is encrypted'); continue; }
      if (e.method !== 0 && e.method !== 8) { refuse(`it is packed with a method the tool cannot read (${e.method})`); continue; }

      let written = 0, crc = 0, why = '';
      try {
        const h = await readAt(fh, e.local, 30);
        if (h.length < 30 || h.readUInt32LE(0) !== 0x04034b50) throw new Error('its header is missing');
        const start = e.local + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Inflated as it is read; every chunk is counted before it is written.
        const source = e.packed ? fs.createReadStream(file, { start, end: start + e.packed - 1 }) : null;
        const data: AsyncIterable<Buffer> | Buffer[] = !source ? [] : e.method === 8 ? pipeline(source, zlib.createInflateRaw(), () => {}) : source;
        const out = await fs.promises.open(target, 'w');
        try {
          for await (const c of data) {
            written += c.length;
            total += c.length;
            if (total > ZIP_LIMITS.total) throw Object.assign(new Error(`it unpacks to more than ${bytes(ZIP_LIMITS.total)}, more than any save the tool knows (stopped at ${shown(e.name)})`), { whole: true });
            if (total > free) throw Object.assign(new Error(`the disk ran out of space while unpacking ${shown(e.name)}`), { whole: true });
            if (written > e.size) throw new Error('it is damaged (it unpacks to more than the zip says)');
            if (written > ZIP_LIMITS.after && written > ZIP_LIMITS.ratio * e.packed) throw new Error(`it unpacks to more than ${ZIP_LIMITS.ratio} times its packed size, like a zip bomb`);
            crc = zlib.crc32(c, crc);
            await out.write(c);
            if (total - told > 8 * MB) progress((told = total), declared);
          }
        } finally {
          await out.close();
          source?.destroy();
        }
        if (written !== e.size) why = 'it is damaged or cut off (it unpacks to less than the zip says)';
        else if (crc !== e.crc) why = 'it is damaged (its checksum does not match)';
      } catch (err) {
        if ((err as { whole?: boolean }).whole) throw err;
        const m = (err as Error).message;
        why = m.startsWith('it ') ? m : `it is damaged or cut off (${m.replace(/\.$/, '')})`;
      }
      if (why) {
        fs.rmSync(target, { force: true });
        refuse(why);
      }
    }
    progress(total, declared);
    return { bytes: total, problems };
  } finally {
    await fh.close();
  }
}

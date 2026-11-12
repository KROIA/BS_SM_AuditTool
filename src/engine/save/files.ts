// Reads the mods' NBT files of a save: players, bank accounts, items, markets, companies.
// Layouts: .claude/DATA_SOURCES.md, "Exact NBT layouts". Anything missing or malformed is skipped, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { readSmallFile } from './locate.ts';
import { big, compound, flag, isCompound, list, num, readNbt, str, uuidFromInts, type Nbt, type NbtCompound } from './nbt.ts';

/** All elements of a chunked list: <dir>/chunk_<i>.nbt in number order, or <dir>.old when <dir> is missing. */
export function readChunks(dir: string): Nbt[] {
  const folder = fs.existsSync(dir) ? dir : dir + '.old';
  let names: string[];
  try {
    names = fs.readdirSync(folder).filter((n) => /^chunk_\d+\.nbt$/.test(n));
  } catch {
    return [];
  }
  const index = (n: string) => Number(n.slice(6, -4));
  const out: Nbt[] = [];
  for (const name of names.sort((a, b) => index(a) - index(b))) {
    try {
      const file = readSmallFile(path.join(folder, name));
      if (file) out.push(...list(readNbt(file), 'data'));
    } catch {
      // a broken chunk is left out; the others still count
    }
  }
  return out;
}
const compounds = (dir: string) => readChunks(dir).filter(isCompound);
const itemId = (c: NbtCompound | undefined, name = 'itemID') => num(compound(c, name), 'id');

export interface PlayerFile { uuid: string; name: string; bankAdmin: boolean; marketAdmin: boolean }
export interface AccountFile {
  number: number; name: string; frozen: boolean; createdMs: number | null; owner: string | null; company: string | null;
  users: { uuid: string; permissions: number }[];
  balances: { item: number; balance: bigint; locked: bigint }[];
}
export interface ItemFile { id: number; name: string; money: boolean }
export interface MarketFile { item: number; price: bigint | null; defaultPrice: bigint | null; maintenance: boolean }
export interface SaveFiles { players: PlayerFile[]; accounts: AccountFile[]; items: ItemFile[]; markets: MarketFile[]; bankVersion: string | null }

export function readFiles(dataDir: string): SaveFiles {
  const bank = path.join(dataDir, 'BankSystem'), market = path.join(dataDir, 'StockMarket', 'MarketManager');

  // Items: the mods number them per world. An alias points an old number at the one that replaced it.
  const items = new Map<number, ItemFile>();
  const alias = new Map<number, number>();
  let bankVersion: string | null = null;
  try {
    const file = readSmallFile(path.join(bank, 'ItemIDs.nbt'));
    const root = file ? readNbt(file) : undefined;
    for (const a of list(root, 'itemIDAliases').filter(isCompound)) {
      const from = num(a, 'from'), to = num(a, 'to');
      if (from !== undefined && to !== undefined) alias.set(from, to);
    }
    for (const e of list(root, 'itemIDs').filter(isCompound)) {
      const id = itemId(e), stack = compound(e, 'itemStack'), name = str(stack, 'id');
      if (id === undefined || !name) continue;
      // Money is whichever number stands for banksystem:money without extra components; it differs between worlds.
      const money = name === 'banksystem:money' && Object.keys(compound(stack, 'components') ?? {}).length === 0;
      items.set(id, { id, name, money });
    }
  } catch {
    // no item names: the screens then show "item 6"
  }
  try {
    const file = readSmallFile(path.join(bank, 'Meta_data.nbt'));
    const root = file ? readNbt(file) : undefined;
    bankVersion = str(root, 'version') ?? null;
    for (const d of list(root, 'itemIDShortNameDigest').filter(isCompound)) { // names of items whose mod is gone
      const id = num(d, 's'), name = str(d, 'n');
      if (id !== undefined && name && !items.has(id)) items.set(id, { id, name, money: false });
    }
  } catch {
    // version stays unknown
  }
  const resolve = (id: number) => { for (let i = 0; i < 8 && alias.has(id); i++) id = alias.get(id)!; return id; };
  for (const [from, to] of alias) { // an old number keeps the name and the role of the number it points to
    const target = items.get(resolve(to));
    if (target && !items.has(from)) items.set(from, { ...target, id: from });
  }

  const players = new Map<string, PlayerFile>();
  const player = (uuid: string) => {
    let p = players.get(uuid);
    if (!p) players.set(uuid, (p = { uuid, name: '', bankAdmin: false, marketAdmin: false }));
    return p;
  };
  for (const u of compounds(path.join(bank, 'Bank_data', 'users'))) {
    const uuid = uuidFromInts(u.userUUID);
    if (!uuid) continue;
    const p = player(uuid);
    p.name = str(u, 'userName') || p.name;
    p.bankAdmin = flag(u, 'isBanksystemAdmin');
  }
  for (const u of compounds(path.join(market, 'users'))) {
    const uuid = uuidFromInts(u.userUUID);
    if (!uuid) continue;
    const p = player(uuid);
    p.name ||= str(u, 'userName') ?? '';
    p.marketAdmin = flag(u, 'isStockMarketAdmin');
  }

  const companyOf = new Map<number, string>();
  for (const c of compounds(path.join(bank, 'Companies', 'companies'))) {
    const account = num(c, 'bankAccountNr');
    if (account !== undefined) companyOf.set(account, str(c, 'name') ?? 'Company');
  }
  // A slot saved under an old id and one under its current id are the same item: added up, not one dropped.
  const balances = (a: NbtCompound) => {
    const out = new Map<number, AccountFile['balances'][number]>();
    for (const b of list(a, 'banks').filter(isCompound)) {
      const raw = itemId(b);
      if (raw === undefined) continue;
      const item = resolve(raw), slot = out.get(item) ?? { item, balance: 0n, locked: 0n };
      slot.balance += big(b, 'balance') ?? 0n;
      slot.locked += big(b, 'lockedBalance') ?? 0n;
      out.set(item, slot);
    }
    return out;
  };
  const accounts: AccountFile[] = [];
  for (const a of compounds(path.join(bank, 'Bank_data', 'bankAccounts'))) {
    const number = num(a, 'accountNumber');
    if (number === undefined) continue;
    accounts.push({
      number, name: str(a, 'accountName') ?? '', frozen: flag(a, 'frozen'), createdMs: num(a, 'createdAt') ?? null,
      owner: uuidFromInts(a.personalBankOwnerDataUUID) ?? null, company: companyOf.get(number) ?? null,
      users: list(a, 'users').filter(isCompound).flatMap((u) => { const uuid = uuidFromInts(u.userUUID); return uuid ? [{ uuid, permissions: num(u, 'permissions') ?? 0 }] : []; }),
      balances: [...balances(a).values()],
    });
  }

  const markets: MarketFile[] = compounds(path.join(market, 'markets')).flatMap((m) => {
    const item = num(m, 'id');
    return item === undefined ? [] : [{ item: resolve(item), price: big(m, 'currentMarketPrice') ?? null, defaultPrice: big(m, 'defaultPrice') ?? null, maintenance: flag(m, 'maintenance') }];
  });

  return { players: [...players.values()], accounts, items: [...items.values()], markets, bankVersion };
}

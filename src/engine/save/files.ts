// Reads the mods' NBT files of a save: players, bank accounts, items, markets, companies.
// Layouts as the mods write them (read from their source). Anything missing or malformed is skipped, never fatal.
import fs from 'node:fs';
import path from 'node:path';
import { readSmallFile } from './locate.ts';
import { big, compound, flag, isCompound, list, num, readNbt, str, uuidFromInts, type Nbt, type NbtCompound } from './nbt.ts';

/**
 * The server's usercache.json, which sits beside the world folder when the server folder was copied: uuid -> name.
 * The third source of names for players the mods' files do not name. Malformed entries are skipped.
 */
export function readUserCache(dataDir: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const file = readSmallFile(path.join(dataDir, '..', '..', 'usercache.json'));
    const entries: unknown = file ? JSON.parse(file.toString('utf8')) : [];
    for (const e of Array.isArray(entries) ? entries : []) {
      const { uuid, name } = (e ?? {}) as { uuid?: unknown; name?: unknown };
      if (typeof uuid === 'string' && typeof name === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid) && /^\w{1,32}$/.test(name)) {
        out.set(uuid.toLowerCase(), name);
      }
    }
  } catch {
    // unreadable: no names from it
  }
  return out;
}

/** The bank mod's flag settings and their defaults (BS BankSystemModSettings.java:456-480). Money in whole units. */
const BANK_AUDIT: Record<string, number | boolean> = {
  LAUNDERING_FLAG_ENABLED: true, LAUNDERING_MIN_AMOUNT: 1_000_000, LAUNDERING_WINDOW_HOURS: 24,
  LARGE_NOTE_WITHDRAWAL_FLAG_ENABLED: true, LARGE_NOTE_WITHDRAWAL_AMOUNT: 10_000_000,
  WEALTH_JUMP_FLAG_ENABLED: true, WEALTH_SWEEP_MINUTES: 10, WEALTH_JUMP_PERCENT: 100, WEALTH_JUMP_AMOUNT: 1_000_000, WEALTH_JUMP_COOLDOWN_HOURS: 6,
  NEW_ACCOUNT_TRANSFER_FLAG_ENABLED: true, NEW_ACCOUNT_TRANSFER_AMOUNT: 1_000_000, NEW_ACCOUNT_AGE_HOURS: 24,
  MONEY_SUPPLY_FLAG_ENABLED: true, MONEY_SUPPLY_GROWTH_PERCENT: 10, MONEY_SUPPLY_GROWTH_AMOUNT: 10_000_000, MONEY_SUPPLY_COOLDOWN_HOURS: 6,
};

/** The "Audit" group of the bank's settings.json. Only the known keys, only values of the default's type; anything else gives the default. */
export function readBankAudit(dataDir: string): Record<string, number | boolean> {
  const out = { ...BANK_AUDIT };
  try {
    const file = readSmallFile(path.join(dataDir, 'BankSystem', 'settings.json'));
    const audit: unknown = file && (JSON.parse(file.toString('utf8')) as { Audit?: unknown } | null)?.Audit;
    if (typeof audit !== 'object' || audit === null) return out;
    for (const [key, def] of Object.entries(BANK_AUDIT)) {
      const v = (audit as Record<string, unknown>)[key];
      if (typeof v === typeof def && (typeof v !== 'number' || (Number.isFinite(v) && v >= 0))) out[key] = v as number | boolean;
    }
  } catch {
    // unreadable: the defaults
  }
  return out;
}

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
/**
 * plain: an ItemIDs entry without components, the number a plain stack of that item id has (not a name digest, not an old alias).
 * money: the server's currency, the item trades settle in. bank: BankSystem's own money, what banknotes are worth; the same
 * item unless the market trades in another one.
 */
export interface ItemFile { id: number; name: string; money: boolean; bank: boolean; plain: boolean }
export interface MarketFile { item: number; price: bigint | null; defaultPrice: bigint | null; maintenance: boolean }
/** aliases: every old item number with the number it ends at. */
export interface SaveFiles { players: PlayerFile[]; accounts: AccountFile[]; items: ItemFile[]; markets: MarketFile[]; bankVersion: string | null; aliases: [number, number][]; currency: string }

export const BANK_MONEY = 'banksystem:money';
/**
 * The market's currency (StockMarket settings.json, "ServerMarket" group, CURRENCY: an item stack as {id, count, components?}).
 * BankSystem money when the file or the key is missing, as on slaves, which never load it.
 */
function readCurrency(dataDir: string): { id: string; components: boolean } {
  try {
    const file = readSmallFile(path.join(dataDir, 'StockMarket', 'settings.json'));
    const c: unknown = file && (JSON.parse(file.toString('utf8')) as { ServerMarket?: { CURRENCY?: unknown } } | null)?.ServerMarket?.CURRENCY;
    if (typeof c === 'object' && c !== null && 'id' in c && typeof c.id === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(c.id) && c.id.length <= 100) {
      const comp = 'components' in c ? c.components : undefined;
      return { id: c.id, components: typeof comp === 'object' && comp !== null && Object.keys(comp).length > 0 };
    }
  } catch {
    // unreadable: the default
  }
  return { id: BANK_MONEY, components: false };
}

export function readFiles(dataDir: string): SaveFiles {
  const bank = path.join(dataDir, 'BankSystem'), market = path.join(dataDir, 'StockMarket', 'MarketManager');
  const currency = readCurrency(dataDir);

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
      // Money is whichever number stands for the currency without extra components; it differs between worlds.
      // ponytail: a currency with components matches every entry of its id that has components, not the exact ones.
      const plain = Object.keys(compound(stack, 'components') ?? {}).length === 0;
      items.set(id, { id, name, money: name === currency.id && plain !== currency.components, bank: name === BANK_MONEY && plain, plain });
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
      if (id !== undefined && name && !items.has(id)) items.set(id, { id, name, money: false, bank: false, plain: false });
    }
  } catch {
    // version stays unknown
  }
  const resolve = (id: number) => { for (let i = 0; i < 8 && alias.has(id); i++) id = alias.get(id)!; return id; };
  for (const [from, to] of alias) { // an old number keeps the name and the role of the number it points to
    const target = items.get(resolve(to));
    if (target && !items.has(from)) items.set(from, { ...target, id: from, plain: false }); // plain: the current number is the one a stack resolves to
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

  return { players: [...players.values()], accounts, items: [...items.values()], markets, bankVersion, aliases: [...alias.keys()].map((from) => [from, resolve(from)]), currency: currency.id };
}

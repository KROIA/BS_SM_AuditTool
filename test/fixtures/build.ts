// Builds invented saves for the tests: a current network (one master, two slaves) and one old 2.1.2 save.
// Names, ids and amounts are made up (DESIGN_SPEC rule 12); the shape follows the scenario of the design canvas:
// two players push a market price up with rapid orders and sell into it.
//
// The table definitions are copied from the mods (BankSystem 3835d933, StockMarket 898aac66):
// common/src/main/resources/sql/*.sql, BankSystem data/DiagnosticsDatabase.java, StockMarket data/OrderOriginLog.java.
// The NBT files follow .claude/DATA_SOURCES.md, "Exact NBT layouts". Region files hold the cases of the region scan (AT-36).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import zlib from 'node:zlib';
import { byte, comp, double, float, int, ints, list as nbtList, long, nbtFile, short, str, uuid, type Tag } from './nbt.ts';

const MIN = 60_000;
/** The first minute of the scenario: 4 Nov 2026, 10:00 UTC. */
export const T0 = Date.UTC(2026, 10, 4, 10, 0, 0);
const MINUTES = 160;

// Item ids are per world; ItemIDs.nbt below gives them their names.
export const ITEM = { money: 1, diamond: 2, emerald: 3, iron: 4, gold: 5, coal: 6, redstone: 7, wheat: 8, oak: 9 } as const;
const ITEM_NAME: Record<number, string> = {
  1: 'banksystem:money', 2: 'minecraft:diamond', 3: 'minecraft:emerald', 4: 'minecraft:iron_ingot', 5: 'minecraft:gold_ingot',
  6: 'minecraft:coal', 7: 'minecraft:redstone', 8: 'minecraft:wheat', 9: 'minecraft:oak_log', 14: 'banksystem:money100',
};
/** A $100 banknote: its own item, not money in the bank's log, but the slave's journal counts it as money. */
export const NOTE = 14;
/** A money item with a custom name: not money, because it has components. */
export const VOUCHER = 12;
/** An id whose mod is gone; only Meta_data's name digest knows it. */
export const GONE = { id: 13, name: 'oldmod:ruby' };
/** An old coal id merged into the current one. Brindle's coal slot is saved under the old id. */
export const ALIAS = { from: 40, to: ITEM.coal };
const BASE_PRICE: Record<number, number> = { 2: 5000, 3: 3000, 4: 400, 5: 900, 6: 120, 7: 150, 8: 60, 9: 80 }; // raw money per item

export const PLAYERS = {
  Tavrik: { n: 1, account: 11 },
  Quenby: { n: 2, account: 7 },
  Ombrelune: { n: 3, account: 24 },
  Mikko_82: { n: 4, account: 27 },
  AdmiralNoor: { n: 5, account: 10 },
  Brindle: { n: 6, account: 3 },
} as const;
type Name = keyof typeof PLAYERS;
/** Accounts that are not a player's own: one shared by two players, one of a company, and three spare ones. */
export const SHARED = { account: 30, name: 'Tavrik and Quenby', users: { Tavrik: 7, Quenby: 3 } as Partial<Record<Name, number>>, start: 2_500_000n };
/** The company account's balance is above 2^53, so only an exact integer keeps it. */
export const COMPANY = { id: 1, name: 'Northreach Rail Co.', account: 41, founder: 'AdmiralNoor' as Name, start: 9_007_199_254_740_993n };
const SPARE = [
  { account: 31, user: 'Mikko_82' as Name, name: 'Old savings', frozen: true },
  { account: 32, user: 'Brindle' as Name, name: 'Farm', frozen: false },
  { account: 33, user: 'AdmiralNoor' as Name, name: 'Admin test', frozen: false },
];
/** Every account in the order the bank files list them, one per chunk file: chunk_0 to chunk_10. */
export const ACCOUNT_ORDER = [...Object.values(PLAYERS).map((p) => p.account), SHARED.account, COMPANY.account, ...SPARE.map((s) => s.account)];
/** Accounts of the master with only the rows and snapshots of one case of the check per account; none is in the bank files. */
export const CHECK = { gain: 12, pair: 13, set: 14, stamp: 15, raw: 16, gone: 17 } as const;
/** The bank's wealth series (item 32767) on the master: account, minute after T0, raw value. */
export const WEALTH = 32767;
export const WEALTH_SNAPS = [[PLAYERS.Tavrik.account, 0, 60_000_000n], [COMPANY.account, 10, 9_007_199_254_840_993n], [PLAYERS.Tavrik.account, 30, 600_000_000n]] as const;
/** A trade row of order 1 logged a second time, on a deleted account: the case of the rule "Order and ledger disagree". */
export const STRAY = { account: 18, order: 1 } as const;
/** When the master's bank last saved: the trade row of the last order (minute 130, +5.3 s) is newer. */
export const LAST_SAVE = T0 + 130 * 60_000;
/** The master's audit log is written in server local time, one hour ahead of UTC. */
export const AUDIT_OFFSET = 60 * 60_000;
/** A flag in the audit log whose SuspicionFlag row is missing: the database lost it. */
export const LOST_FLAG = { account: 7, type: 2, severity: 3, amount: 1_500_000_000n, ts: T0 + 100 * 60_000 } as const;
const SHARE_DETAILS = 'more shares than issued\nissued: 1000 shares\nheld: 1005 shares';
export const MINECRAFT = '1.21.1';

/** Invented UUIDs whose halves do not fit into a floating-point number, like real ones. */
export const uuidText = (n: number) => `a1b2c3d4-e5f6-4a7b-8c9d-${n.toString(16).padStart(12, '0')}`;
const uuidHalves = (n: number): [bigint, bigint] => [BigInt.asIntN(64, 0xa1b2c3d4e5f64a7bn), BigInt.asIntN(64, 0x8c9d000000000000n + BigInt(n))];
const MASTER_UID = 'f0000000-0000-4000-8000-000000000001';
const SLAVES = [
  { name: 'mining-1', uid: 'f0000000-0000-4000-8000-000000000002' },
  { name: 'nether-hub', uid: 'f0000000-0000-4000-8000-000000000003' },
];

const SQL = {
  orderHistory: `CREATE TABLE OrderHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, itemid INTEGER NOT NULL, accountid INTEGER NOT NULL,
    userid_one INTEGER NOT NULL, userid_two INTEGER NOT NULL, type INTEGER NOT NULL, amount INTEGER NOT NULL, price INTEGER NOT NULL,
    time DATETIME NOT NULL, intermarket_group_one INTEGER NOT NULL DEFAULT 0, intermarket_group_two INTEGER NOT NULL DEFAULT 0, order_id INTEGER,
    finish_time INTEGER, limit_price INTEGER, target_volume INTEGER, final_status INTEGER);
    CREATE INDEX idx_itemid_userid_time ON OrderHistory (itemid, accountid)`,
  orderHistoryLegacy: `CREATE TABLE OrderHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, itemid INTEGER NOT NULL, accountid INTEGER NOT NULL,
    userid_one INTEGER NOT NULL, userid_two INTEGER NOT NULL, type INTEGER NOT NULL, amount INTEGER NOT NULL, price INTEGER NOT NULL,
    time DATETIME NOT NULL, intermarket_group_one INTEGER NOT NULL DEFAULT 0, intermarket_group_two INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_itemid_userid_time ON OrderHistory (itemid, accountid)`,
  marketPrice: `CREATE TABLE MarketPrice (id INTEGER PRIMARY KEY AUTOINCREMENT, marketid INTEGER NOT NULL, open INTEGER NOT NULL,
    low INTEGER NOT NULL, high INTEGER NOT NULL, time INTEGER NOT NULL, traded_volume REAL NOT NULL DEFAULT 0, game_time INTEGER NOT NULL DEFAULT -1);
    CREATE INDEX idx_marketprice_marketid_time ON MarketPrice (marketid, time)`,
  marketPriceLegacy: `CREATE TABLE MarketPrice (id INTEGER PRIMARY KEY AUTOINCREMENT, marketid INTEGER NOT NULL, open INTEGER NOT NULL,
    low INTEGER NOT NULL, high INTEGER NOT NULL, time INTEGER NOT NULL, traded_volume REAL NOT NULL DEFAULT 0);
    CREATE INDEX idx_marketprice_marketid_time ON MarketPrice (marketid, time)`,
  transactionLog: `CREATE TABLE TransactionLog (id INTEGER PRIMARY KEY AUTOINCREMENT, account_number INTEGER NOT NULL, actor_uuid TEXT,
    kind TEXT NOT NULL, item_id INTEGER NOT NULL, amount INTEGER NOT NULL, other_account INTEGER, company_id INTEGER, ts INTEGER NOT NULL,
    note TEXT, source_kind TEXT NOT NULL DEFAULT 'UNKNOWN', tag TEXT, type_code INTEGER NOT NULL DEFAULT 0, ref TEXT, money_amount INTEGER,
    price INTEGER, currency_item INTEGER, actor_name TEXT, balance_after INTEGER, virtual_qty INTEGER,
    origin_server TEXT, dimension TEXT, x INTEGER, y INTEGER, z INTEGER);
    CREATE INDEX idx_tx_log_account_ts ON TransactionLog (account_number, ts DESC);
    CREATE INDEX idx_tx_log_company_ts ON TransactionLog (company_id, ts DESC)`,
  // 2.1.2, read from the table definitions of a real save of that version. Its log only held DEPOSIT, WITHDRAW and share rows.
  transactionLogLegacy: `CREATE TABLE TransactionLog (id INTEGER PRIMARY KEY AUTOINCREMENT, account_number INTEGER NOT NULL, actor_uuid TEXT,
    kind TEXT NOT NULL, item_id INTEGER NOT NULL, amount INTEGER NOT NULL, other_account INTEGER, company_id INTEGER, ts INTEGER NOT NULL, note TEXT,
    source_kind TEXT NOT NULL DEFAULT 'UNKNOWN', tag TEXT)`,
  balanceHistory: `CREATE TABLE BalanceHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, account_number INTEGER NOT NULL, item_id INTEGER NOT NULL,
    balance INTEGER NOT NULL, locked_balance INTEGER NOT NULL, time INTEGER NOT NULL);
    CREATE INDEX idx_balance_history ON BalanceHistory (account_number, item_id, time)`,
  suspicionFlag: `CREATE TABLE SuspicionFlag (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, account_number INTEGER NOT NULL,
    flag_type INTEGER NOT NULL, severity INTEGER NOT NULL DEFAULT 0, amount INTEGER NOT NULL DEFAULT 0, ref TEXT, details TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_flag_ts ON SuspicionFlag (ts DESC)`,
  payoutHistory: `CREATE TABLE PayoutHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, schedule_id INTEGER NOT NULL,
    source_account INTEGER NOT NULL, target_uuid TEXT NOT NULL, amount INTEGER NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL,
    target_player_name TEXT NOT NULL DEFAULT '', target_account_name TEXT NOT NULL DEFAULT '', currency_item INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'NORMAL')`,
  meta: `CREATE TABLE Meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  transferJournal: `CREATE TABLE TransferJournal (id INTEGER PRIMARY KEY AUTOINCREMENT, transfer_id TEXT NOT NULL, ts INTEGER NOT NULL,
    direction TEXT, path TEXT, step TEXT NOT NULL, account_number INTEGER, player_uuid TEXT, items_json TEXT, ledger_type INTEGER,
    context TEXT, detail TEXT);
    CREATE INDEX TransferJournal_tid ON TransferJournal(transfer_id)`,
  noteFlow: `CREATE TABLE NoteFlow (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, player_uuid TEXT,
    item_id INTEGER NOT NULL, amount INTEGER NOT NULL, context TEXT, villager_uuid TEXT, dimension TEXT, x INTEGER, y INTEGER, z INTEGER)`,
  orderOrigin: `CREATE TABLE OrderOrigin (ref TEXT PRIMARY KEY, origin_server_uid TEXT, origin_name TEXT NOT NULL)`,
  // SM-316 (SM 21d29820, data/OrderOriginLog.java)
  tradeAlert: `CREATE TABLE TradeAlert (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, player_uuid TEXT, account_number INTEGER,
    item_id INTEGER, amount INTEGER, window_ms INTEGER, threshold REAL, text TEXT NOT NULL, order_ids TEXT)`,
};

/** Creates a database file, runs the definitions, and hands out one function that inserts a row. */
function database(file: string, definitions: string[], wal = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode = WAL'); // the mods' diagnostics files are in this mode
  for (const d of definitions) db.exec(d);
  db.exec('BEGIN');
  const counts: Record<string, number> = {};
  return {
    insert(table: string, row: Record<string, SQLInputValue>) {
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
      counts[table] = (counts[table] ?? 0) + 1;
    },
    close() {
      db.exec('COMMIT');
      db.close();
      return counts;
    },
  };
}

/** Small repeatable random numbers, so every build gives the same saves. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** One price per market and minute. Diamond is pushed to 40 times its price and falls back; emerald to 12 times. */
function prices(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const [id, base] of Object.entries(BASE_PRICE)) {
    const rnd = random(Number(id));
    const list: number[] = [];
    let p = base;
    for (let m = 0; m <= MINUTES; m++) {
      p = Math.max(1, Math.round(p * (1 + (rnd() - 0.5) * 0.02)));
      const push = Number(id) === ITEM.diamond ? bump(m, 20, 40, 60, 40) : Number(id) === ITEM.emerald ? bump(m, 45, 60, 80, 12) : 1;
      list.push(Math.round(p * push));
    }
    out.set(Number(id), list);
  }
  return out;
}
/** 1 outside [start, end], rising to `top` at `peak` and falling back. */
function bump(m: number, start: number, peak: number, end: number, top: number): number {
  if (m <= start || m >= end) return 1;
  const t = m <= peak ? (m - start) / (peak - start) : (end - m) / (end - peak);
  return 1 + (top - 1) * t;
}

/** limit: SM-317 limit price (0 = market order); wanted: the volume asked for; status: 0 filled, 1 cancelled by the player, 2 by the server. */
interface Order { id: number; item: number; player: Name; type: number; amount: bigint; price: bigint; time: number; finish: number; limit: bigint; wanted: bigint; status: number }

function orders(price: Map<number, number[]>, flow: boolean): Order[] {
  const list: Order[] = [];
  const add = (player: Name, item: number, minute: number, offsetMs: number, amount: bigint, type = 0) =>
    list.push({ id: 0, item, player, type, amount, price: BigInt(price.get(item)![minute]!), time: T0 + minute * MIN + offsetMs,
      finish: T0 + minute * MIN + offsetMs + (type === 1 ? 7 * MIN : 400), // SM-317: a limit order waits in the book, a market order fills at once
      limit: type === 1 ? BigInt(price.get(item)![minute]!) : 0n, wanted: amount, status: 0 });
  // Ordinary trading
  add('Brindle', ITEM.coal, 5, 1200, 6400n);
  add('Brindle', ITEM.coal, 62, 400, 3200n);
  add('Brindle', ITEM.iron, 90, 9000, -1600n, 1);
  add('Mikko_82', ITEM.wheat, 12, 300, -12800n);
  add('Mikko_82', ITEM.wheat, 130, 5300, -6400n);
  add('Ombrelune', ITEM.gold, 100, 700, 800n, 1);
  // The pump: 30 buys 20 ms apart while the price is low, 30 sells 20 ms apart at the top
  for (let i = 0; i < 30; i++) add('Tavrik', ITEM.diamond, 21, i * 20, 10000n);
  for (let i = 0; i < 30; i++) add('Tavrik', ITEM.diamond, 40, i * 20, -10000n);
  for (let i = 0; i < 10; i++) add('Quenby', ITEM.emerald, 46, i * 20, 5000n);
  for (let i = 0; i < 10; i++) add('Quenby', ITEM.emerald, 60, i * 20, -5000n);
  list.sort((a, b) => a.time - b.time);
  list.forEach((o, i) => (o.id = i + 1));
  // SM-317: Ombrelune wanted twice the gold at a higher limit and cancelled the rest; the server cancelled half of Mikko's last sale.
  Object.assign(list.find((o) => o.player === 'Ombrelune')!, { wanted: ORDER_END.goldWanted, limit: ORDER_END.goldLimit, status: 1 });
  Object.assign(list.findLast((o) => o.player === 'Mikko_82')!, { wanted: ORDER_END.wheatWanted, status: 2 });
  if (!flow) return list;
  // The money flow (AT-40): Tavrik buys coal and sells half of it back for less, so he keeps goods and loses money there.
  // Numbered last so no other order's id moves; before the bank's last save (minute 130) so no row is newer than it.
  // Ombrelune rides along on the pump: the far-price finding at its top names her too, so the incident has two players.
  add('Ombrelune', ITEM.diamond, 21, 900, FLOW.ride);
  add('Ombrelune', ITEM.diamond, 40, 900, -FLOW.ride);
  add('Tavrik', ITEM.coal, 128, 300, FLOW.coalBought);
  add('Tavrik', ITEM.coal, 129, 300, -FLOW.coalSold);
  list.at(-1)!.price = (list.at(-1)!.price * 9n) / 10n;
  list.slice(-4).forEach((o, i) => (o.id = list.length - 3 + i));
  return list;
}

/**
 * Tavrik's money besides the pump, so his incident's money flow has every part (AT-40). Raw amounts. Coal bought and half
 * sold back below its price; money from a deleted account (19); an admin adding money; a company payout; money that appears
 * without a row, below the threshold; on 2.1.2 notes paid back through the converter (no row there).
 */
export const FLOW = {
  ride: 1_000n, coalBought: 2_000_000n, coalSold: 1_000_000n, from: 19, received: 25_000_000n, adminAdd: 500_000_000n, payout: 2_000_000n, unexplained: 50_000n,
  converter: 30_000_000n,
} as const;

/** SM-317 values of the two orders that did not simply fill. */
export const ORDER_END = { goldWanted: 1600n, goldLimit: 1000n, wheatWanted: -12800n } as const;

function identity(dataDir: string, json: Record<string, unknown>) {
  fs.mkdirSync(path.join(dataDir, 'ModUtilities'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'ModUtilities', 'server_identity.json'), JSON.stringify(json, null, 2));
}

function marketDatabase(dataDir: string, legacy: boolean, price: Map<number, number[]>, list: Order[]) {
  const db = database(path.join(dataDir, 'StockMarket/Database/stockdata.db'), legacy ? [SQL.orderHistoryLegacy, SQL.marketPriceLegacy] : [SQL.orderHistory, SQL.marketPrice]);
  for (const [market, p] of price) {
    const rnd = random(market * 7919);
    for (let m = 0; m < MINUTES; m++) {
      const open = p[m]!, close = p[m + 1]!; // the mods store no close: it is the next candle's open
      let low = Math.round(Math.min(open, close) * (1 - rnd() * 0.01));
      const high = Math.round(Math.max(open, close) * (1 + rnd() * 0.01));
      // The price spike: at the top of the pump one diamond minute reaches down to a sixth of its high. Still above the
      // lowest low of its hour and of the scenario, so no other figure moves.
      if (market === ITEM.diamond && m === 40) low = Math.round(high / 6);
      db.insert('MarketPrice', {
        marketid: market, open, low, high,
        time: T0 + m * MIN, traded_volume: Math.round(rnd() * 5000), ...(legacy ? {} : { game_time: 24000 + m * 1200 }),
      });
    }
  }
  for (const o of list) {
    const [one, two] = uuidHalves(PLAYERS[o.player].n);
    db.insert('OrderHistory', {
      itemid: o.item, accountid: PLAYERS[o.player].account, userid_one: one, userid_two: two, type: o.type, amount: o.amount, price: o.price, time: o.time,
      ...(legacy ? {} : { order_id: o.id, finish_time: o.finish, limit_price: o.limit, target_volume: o.wanted, final_status: o.status }),
    });
  }
  return db.close();
}

/** BS-258 places of two terminal rows on the master. */
export const PLACES = {
  withdraw: { dimension: 'minecraft:overworld', x: -230, y: 70, z: -920 },
  deposit: { dimension: 'minecraft:the_nether', x: 12, y: 64, z: -40 },
} as const;

/** Bank log and balance snapshots that agree with each other and with the orders. */
/** A master ledger row with a transfer id. amount: what it did to the balance (signed); a DEPOSIT unless kind says else. */
type RefRow = { id: string; account: number; amount: bigint; ts: number; player: Name; kind?: string; code?: number; item?: number; server?: string };

function bankDatabase(dataDir: string, legacy: boolean, list: Order[], transfers: RefRow[], flow: boolean) {
  const db = database(path.join(dataDir, 'BankSystem/Database/banksystem.db'),
    legacy ? [SQL.transactionLogLegacy, SQL.balanceHistory, SQL.payoutHistory] : [SQL.transactionLog, SQL.balanceHistory, SQL.suspicionFlag, SQL.payoutHistory]);
  const balance = new Map<string, bigint>(); // "account:item" -> raw
  const touched = new Map<string, number>(); // "account:item" -> last change
  const change = (account: number, item: number, delta: bigint, ts: number) => {
    const key = `${account}:${item}`;
    balance.set(key, (balance.get(key) ?? 0n) + delta);
    touched.set(key, ts);
    return balance.get(key)!;
  };
  const actor = (player: Name) => ({ actor_uuid: uuidText(PLAYERS[player].n), ...(legacy ? {} : { actor_name: player }) });
  // The current mods fill the type code, who acted and the balance afterwards; 2.1.2 only has the text kind.
  const row = (r: Record<string, SQLInputValue>, extra: Record<string, SQLInputValue>) => db.insert('TransactionLog', legacy ? r : { ...r, ...extra });

  const start = T0 - 24 * 60 * MIN;
  const starts: [number, Name, bigint][] = [
    // Tavrik starts with enough for the pump's buys ($440k): a balance below zero is impossible in the bank.
    ...Object.entries(PLAYERS).map(([name, p]): [number, Name, bigint] => [p.account, name as Name, name === 'Tavrik' ? 50_000_000n : 10_000_000n]),
    [SHARED.account, 'Tavrik', SHARED.start], [COMPANY.account, COMPANY.founder, COMPANY.start],
  ];
  for (const [account, by, amount] of starts) {
    const after = change(account, ITEM.money, amount, start);
    if (legacy) continue; // 2.1.2 created the account with its starting balance and no row (ServerBankManager createPersonal)
    row({ account_number: account, ...actor(by), kind: legacy ? 'DEPOSIT' : 'STARTING_BALANCE', item_id: ITEM.money, amount, ts: start },
      { type_code: 19, source_kind: 'SYSTEM', balance_after: after });
  }

  type Event = { ts: number; run: () => void };
  const events: Event[] = [];
  for (const o of list) {
    events.push({ ts: o.time, run: () => {
      const account = PLAYERS[o.player].account, buy = o.amount > 0n;
      const volume = buy ? o.amount : -o.amount, cost = volume * o.price / 100n;
      change(account, ITEM.money, buy ? -cost : cost, o.time);
      change(account, o.item, buy ? volume : -volume, o.time);
      // 2.1.2 wrote no trade rows at all. The current mods write one row per finished order, without a balance.
      if (!legacy) db.insert('TransactionLog', { account_number: account, ...actor(o.player), kind: buy ? 'TRADE_BUY' : 'TRADE_SELL', type_code: buy ? 4 : 5,
        item_id: o.item, amount: volume, ts: o.time, source_kind: 'STOCKMARKET', tag: 'CLOSE', ref: `sm:order:${o.id}`, money_amount: cost, price: o.price, currency_item: ITEM.money });
    } });
  }
  const simple = (player: Name, by: Name, minute: number, kind: string, code: number, delta: bigint, source: string, more: Record<string, SQLInputValue> = {},
    current: Record<string, SQLInputValue> = {}) =>
    events.push({ ts: T0 + minute * MIN + 500, run: () => {
      const account = PLAYERS[player].account, ts = T0 + minute * MIN + 500;
      const after = change(account, ITEM.money, delta, ts);
      if (legacy && kind.startsWith('ADMIN')) return; // 2.1.2 did not log admin actions: the balance moves and the log is silent
      row({ account_number: account, ...actor(by), kind, item_id: ITEM.money, amount: delta < 0n ? -delta : delta, ts, ...more },
        { type_code: code, source_kind: source, balance_after: after, ...current });
    } });
  // Banknotes out at the top of the pump, in again through another player, and an admin taking money back.
  // BS-258: two terminal rows carry where the player stood; BS-256: the second withdrawal was made on a slave.
  simple('Tavrik', 'Tavrik', 50, 'WITHDRAW', 2, -200_000_000n, 'PLAYER', {}, PLACES.withdraw);
  simple('Tavrik', 'Tavrik', 51, 'WITHDRAW', 2, -200_000_000n, 'PLAYER', {}, { origin_server: 'mining-1' });
  if (legacy) {
    // 2.1.2 logged the $2M asked for, then put the $500'000 of notes that did not fit back without a row (putRemainingItemsBack).
    events.push({ ts: T0 + 51 * MIN + 600, run: () => change(PLAYERS.Tavrik.account, ITEM.money, 50_000_000n, T0 + 51 * MIN + 600) });
    // Notes paid in through the ATM converter: 2.1.2 wrote no row (ConverterCommitToBankPacket).
    events.push({ ts: T0 + 80 * MIN + 500, run: () => change(PLAYERS.Brindle.account, ITEM.money, 150_000_000n, T0 + 80 * MIN + 500) });
    // An admin raising a balance: 2.1.2 logged no admin action, and $10M is more than all notes outside the bank then.
    events.push({ ts: T0 + 90 * MIN + 500, run: () => change(PLAYERS.Mikko_82.account, ITEM.money, 1_000_000_000n, T0 + 90 * MIN + 500) });
  }
  simple('Ombrelune', 'Ombrelune', 70, 'DEPOSIT', 1, 300_000_000n, 'PLAYER', {}, PLACES.deposit);
  simple('Quenby', 'AdmiralNoor', 120, 'ADMIN_REMOVE', 9, -20_000_000n, 'ADMIN', { note: 'exploit profit removed' });
  // An admin sets a balance: the row stores |new - old|, the direction is only in the note.
  simple('AdmiralNoor', 'AdmiralNoor', 125, 'ADMIN_SET', 7, -2_500_000n, 'ADMIN', { note: 'money set AdmiralNoor: 10000000->7500000' });
  // A transfer between two accounts: one signed row on each side. Left out of the old save: how 2.1.2 logged transfers is not verified.
  if (!legacy) events.push({ ts: T0 + 55 * MIN, run: () => {
    const ts = T0 + 55 * MIN, from = PLAYERS.Tavrik.account, to = PLAYERS.Ombrelune.account, amount = 100_000_000n;
    const a = change(from, ITEM.money, -amount, ts), b = change(to, ITEM.money, amount, ts);
    row({ account_number: from, ...actor('Tavrik'), kind: 'TRANSFER', item_id: ITEM.money, amount: -amount, other_account: to, ts },
      { type_code: 3, source_kind: 'PLAYER', balance_after: a });
    row({ account_number: to, ...actor('Tavrik'), kind: 'TRANSFER', item_id: ITEM.money, amount, other_account: from, ts },
      { type_code: 3, source_kind: 'PLAYER', balance_after: b });
  } });
  // The money flow (AT-40), Tavrik besides the pump (FLOW): money from a deleted account (its side of the log is gone), an
  // admin adding money (2.1.2: no row), a company payout, a gain without a row below the threshold, on 2.1.2 the converter.
  const tavrik = PLAYERS.Tavrik.account;
  if (flow && !legacy) events.push({ ts: T0 + 56 * MIN, run: () => {
    const ts = T0 + 56 * MIN;
    row({ account_number: tavrik, kind: 'TRANSFER', item_id: ITEM.money, amount: FLOW.received, other_account: FLOW.from, ts },
      { type_code: 3, source_kind: 'PLAYER', balance_after: change(tavrik, ITEM.money, FLOW.received, ts) });
  } });
  if (flow) simple('Tavrik', 'AdmiralNoor', 126, 'ADMIN_ADD', 8, FLOW.adminAdd, 'ADMIN', { note: 'event prize' });
  if (flow && !legacy) simple('Tavrik', 'Tavrik', 127, 'PAYOUT', 20, FLOW.payout, 'SYSTEM', { other_account: COMPANY.account });
  if (flow) events.push({ ts: T0 + 127 * MIN + 700, run: () => change(tavrik, ITEM.money, FLOW.unexplained, T0 + 127 * MIN + 700) });
  if (flow && legacy) events.push({ ts: T0 + 85 * MIN + 500, run: () => change(tavrik, ITEM.money, FLOW.converter, T0 + 85 * MIN + 500) });
  // Rows of transfers with a slave carry the transfer id as their reference (current mods only).
  if (!legacy) for (const t of transfers) events.push({ ts: t.ts, run: () => {
    const after = change(t.account, t.item ?? ITEM.money, t.amount, t.ts);
    db.insert('TransactionLog', { account_number: t.account, ...actor(t.player), kind: t.kind ?? 'DEPOSIT', type_code: t.code ?? 1, item_id: t.item ?? ITEM.money,
      amount: t.amount < 0n ? -t.amount : t.amount, ts: t.ts, source_kind: 'PLAYER', ref: t.id, balance_after: after, origin_server: t.server ?? null });
  } });

  // One snapshot per account and item at the start, then one at the end of every minute in which it changed.
  const snapshot = (key: string, time: number) => {
    const [account, item] = key.split(':').map(Number);
    db.insert('BalanceHistory', { account_number: account!, item_id: item!, balance: balance.get(key)!, locked_balance: 0, time });
  };
  for (const key of balance.keys()) snapshot(key, start);
  touched.clear();
  events.sort((a, b) => a.ts - b.ts);
  let minute = Math.floor(events[0]!.ts / MIN);
  const flush = (upTo: number) => {
    for (const key of touched.keys()) snapshot(key, (upTo + 1) * MIN);
    touched.clear();
  };
  for (const e of events) {
    const m = Math.floor(e.ts / MIN);
    if (m !== minute) flush(minute);
    minute = m;
    e.run();
  }
  flush(minute);

  if (!legacy) {
    // Cases for the check per account (DESIGN_SPEC 8.4), on account numbers that are in no bank file, like deleted accounts:
    // that keeps every value of the accounts above. Rows without an actor, so no player's activity moves.
    const snap = (account: number, minute: number, v: bigint, item: number = ITEM.money) =>
      db.insert('BalanceHistory', { account_number: account, item_id: item, balance: v, locked_balance: 0, time: T0 + minute * MIN });
    const log = (account: number, minute: number, kind: string, code: number, item: number, amount: bigint, more: Record<string, SQLInputValue>) =>
      db.insert('TransactionLog', { account_number: account, kind, type_code: code, item_id: item, amount, ts: T0 + minute * MIN + 500, ...more });
    // 12: money that appears without a row.
    snap(CHECK.gain, 10, 1_000_000n);
    snap(CHECK.gain, 11, 1_500_000n);
    // 13: a difference and its reverse within 15 minutes (joined to nothing), then a pair 38 minutes apart (left as two).
    for (const [m, v] of [[20, 2_000_000n], [21, 2_300_000n], [22, 2_000_000n], [40, 2_100_000n], [60, 2_000_000n]] as const) snap(CHECK.pair, m, v);
    // 14: an admin set whose note gives no direction.
    snap(CHECK.set, 30, 5_000_000n);
    log(CHECK.set, 30, 'ADMIN_SET', 7, ITEM.money, 1_000_000n, { source_kind: 'ADMIN', note: 'balance corrected', balance_after: 4_000_000n });
    snap(CHECK.set, 31, 4_000_000n);
    // 15: a share stamped on a company account (item 0, one share): no balance moves.
    snap(CHECK.stamp, 35, 700_000n);
    log(CHECK.stamp, 35, 'SHARE_STAMP', 22, 0, 1n, { source_kind: 'PLAYER' });
    snap(CHECK.stamp, 36, 700_000n);
    // 16: BS-254 with a StockMarket before SM-318: one fill as RAW_CHANGE rows and as a trade row. The first type 29 row
    // makes later gaps rate high; the one after it is a gain without a row.
    snap(CHECK.raw, 101, 1_000_000n);
    snap(CHECK.raw, 101, 10_000n, ITEM.diamond);
    log(CHECK.raw, 101, 'RAW_CHANGE', 29, ITEM.money, 200_000n, { source_kind: 'UNKNOWN', balance_after: 1_200_000n });
    log(CHECK.raw, 101, 'RAW_CHANGE', 29, ITEM.diamond, -4_000n, { source_kind: 'UNKNOWN', balance_after: 6_000n });
    log(CHECK.raw, 101, 'TRADE_SELL', 5, ITEM.diamond, 4_000n, { source_kind: 'STOCKMARKET', tag: 'PERIODIC', money_amount: 200_000n, price: 5_000n, currency_item: ITEM.money });
    snap(CHECK.raw, 102, 1_200_000n);
    snap(CHECK.raw, 102, 6_000n, ITEM.diamond);
    snap(CHECK.raw, 110, 1_300_000n);
    // 17: a deleted account with two snapshots and no rows.
    snap(CHECK.gone, 5, 250_000n);
    snap(CHECK.gone, 6, 250_000n);
    // The bank's wealth series: Tavrik's grows tenfold, the company's comes in between and stays (carried forward).
    for (const [account, m, v] of WEALTH_SNAPS) snap(account, m, v, WEALTH);
    // Order and ledger disagree: a stray PERIODIC row of order 1 (Brindle's first coal buy), so its rows add up to more than
    // its volume. It sits on a deleted account without snapshots, so no account's figures and no check move.
    log(STRAY.account, 5, 'TRADE_BUY', 4, ITEM.coal, 3_200n, { source_kind: 'STOCKMARKET', tag: 'PERIODIC', ref: `sm:order:${STRAY.order}`,
      money_amount: 3_840n, price: 120n, currency_item: ITEM.money });

    // A slave's code the master rejected: stored as UNKNOWN_LEGACY, unsigned, so the note count cannot tell its direction.
    log(STRAY.account, 75, 'UNKNOWN_LEGACY', 0, ITEM.money, 30_000n, { source_kind: 'PLAYER', note: 'rejected code 25 from slave mining-1', origin_server: 'mining-1' });
    // An admin deletes Quenby: the $50 left is paid out in notes. The notes are Quenby's, the actor is the admin.
    log(STRAY.account, 76, 'ACCOUNT_DELETE_PAYOUT', 25, ITEM.money, 5_000n, { source_kind: 'ADMIN', ...actor('AdmiralNoor'), note: `user deleted: ${uuidText(PLAYERS.Quenby.n)}` });

    db.insert('SuspicionFlag', { ts: T0 + 45 * MIN, account_number: PLAYERS.Tavrik.account, flag_type: 3, severity: 1, amount: 3_900_000_000n, details: 'wealth more than doubled within one hour' });
    db.insert('SuspicionFlag', { ts: T0 + 70 * MIN + 600, account_number: PLAYERS.Ombrelune.account, flag_type: 1, severity: 2, amount: 300_000_000n,
      details: 'banknote deposit 3000000.00\nown withdrawals in 24 h: 0.00' });
    // A share excess an admin has already looked at: critical, acknowledged.
    db.insert('SuspicionFlag', { ts: T0 + 60 * MIN, account_number: COMPANY.account, flag_type: 8, severity: 3, amount: 500, details: SHARE_DETAILS,
      acknowledged: 1 });
  }
  return { counts: db.close(), balance };
}

/**
 * The bank's audit log (BS AdminAudit.java): a line per admin action and per flag, in server local time, CRLF as on a
 * Windows server. Both shapes of ADMIN lines: with a ledger row, and BS-257 changes without one. A file of the day
 * before holds a line the bank did not write; a digest and a file with another name are not the log.
 */
function auditLog(dataDir: string) {
  const dir = path.join(dataDir, 'BankSystem', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  const at = (ms: number) => new Date(ms + AUDIT_OFFSET).toISOString().slice(0, 19).replace('T', ' ');
  const noor = `AdmiralNoor (${uuidText(PLAYERS.AdmiralNoor.n)})`;
  const lines: [number, string][] = [
    [T0 + 30 * MIN + 500, `ADMIN ADMIN_SET account ${CHECK.set} item ${ITEM.money} amount 1000000 by ADMIN note "balance corrected"`],
    [T0 + 45 * MIN, `FLAG 3 account ${PLAYERS.Tavrik.account} severity 1 amount 3900000000 "wealth more than doubled within one hour"`],
    [T0 + 60 * MIN, `FLAG 8 account ${COMPANY.account} severity 3 amount 500 "${SHARE_DETAILS}"`],
    [T0 + 65 * MIN, `ADMIN FLAG_ACK company ${COMPANY.id} "${COMPANY.name}" account ${COMPANY.account} flag SHARE_EXCESS excess 500 state acknowledged by ${noor}`],
    [T0 + 70 * MIN + 600, `FLAG 1 account ${PLAYERS.Ombrelune.account} severity 2 amount 300000000 "banknote deposit 3000000.00\nown withdrawals in 24 h: 0.00"`],
    [LOST_FLAG.ts, `FLAG ${LOST_FLAG.type} account ${LOST_FLAG.account} severity ${LOST_FLAG.severity} amount ${LOST_FLAG.amount} ref note:lost "large banknote withdrawal"`],
    [T0 + 120 * MIN + 500, `ADMIN ADMIN_REMOVE account ${PLAYERS.Quenby.account} item ${ITEM.money} amount 20000000 by ${noor} note "exploit profit removed"`],
    [T0 + 125 * MIN + 500, `ADMIN ADMIN_SET account ${PLAYERS.AdmiralNoor.account} item ${ITEM.money} amount 2500000 by ${noor} note "money set AdmiralNoor: 10000000->7500000"`],
    [T0 + 128 * MIN, `ADMIN RIGHTS_OP player ${uuidText(PLAYERS.Brindle.n)} "Brindle" state admin by ${noor}`],
    [T0 + 129 * MIN, 'ADMIN SLAVE_TRUST slave "mining-1" state trusted by CONSOLE'],
  ];
  fs.writeFileSync(path.join(dir, at(T0).slice(0, 10) + '.log'), lines.map(([ms, l]) => `${at(ms)} ${l}\r\n`).join(''));
  fs.writeFileSync(path.join(dir, at(T0 - 24 * 60 * MIN).slice(0, 10) + '.log'), 'server restarted, audit file rotated by hand\n');
  fs.writeFileSync(path.join(dir, 'digest-' + at(T0).slice(0, 10) + '.md'), '# Digest\n\n2026-11-04 11:00:00 FLAG 9 account 1 severity 1\n');
  fs.writeFileSync(path.join(dir, 'notes.log'), '2026-11-04 11:00:00 FLAG 9 account 1 severity 1\n');
}

/** A chunked list as the mods write it: <dir>/chunk_<i>.nbt, elementType only in chunk_0, no file for an empty list. */
function chunked(dir: string, elements: Tag[], perChunk: number) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i * perChunk < elements.length; i++) {
    const part = elements.slice(i * perChunk, (i + 1) * perChunk);
    fs.writeFileSync(path.join(dir, `chunk_${i}.nbt`), nbtFile({ ...(i === 0 ? { elementType: byte(part[0]!.t) } : {}), data: nbtList(part) }));
  }
}

/** Minecraft's level.dat with the two values the tool reads. */
function levelDat(world: string, lastPlayed: number) {
  fs.writeFileSync(path.join(world, 'level.dat'), nbtFile({ Data: comp({
    LastPlayed: long(lastPlayed), LevelName: str(path.basename(world)), DataVersion: int(3955),
    Version: comp({ Id: int(3955), Name: str(MINECRAFT), Snapshot: byte(false) }),
  }) }));
}

// ---- Player files (playerdata/<uuid>.dat): stacks as Minecraft 1.21 writes them, one file in the older layout.
type Stack = Record<string, Tag>;
export const stackOf = (id: string, count: number, components?: Stack): Stack => ({ id: str(id), count: int(count), ...(components ? { components: comp(components) } : {}) });
export const shulkerOf = (inner: Stack[]): Stack =>
  stackOf('minecraft:shulker_box', 1, { 'minecraft:container': nbtList(inner.map((s, i) => comp({ slot: int(i), item: comp(s) }))) });
const bundleOf = (inner: Stack[]): Stack => stackOf('minecraft:bundle', 1, { 'minecraft:bundle_contents': nbtList(inner.map((s) => comp(s))) });
const note = (dollars: number, count: number) => stackOf(`banksystem:money${dollars}`, count);
const slots = (stacks: Stack[]) => nbtList(stacks.map((s, i) => comp({ Slot: byte(i % 100), ...s })));
/** A player file with the two lists the tool reads, beside a few it does not. */
export const playerNbt = (inventory: Stack[], ender: Stack[]) =>
  nbtFile({ DataVersion: int(3955), Health: float(20), Inventory: slots(inventory), EnderItems: slots(ender), SelectedItemSlot: int(0) });
const playerFile = (world: string, who: Name, file: Buffer, ext = '.dat') => {
  fs.mkdirSync(path.join(world, 'playerdata'), { recursive: true });
  fs.writeFileSync(path.join(world, 'playerdata', uuidText(PLAYERS[who].n) + ext), file);
};
/**
 * What the player files hold, raw money. The master's count says 98'096'200 should be outside the bank; the files hold
 * 80'624'000, so 17'472'200 are not found. Tavrik (only a .dat_old) and Ombrelune (a damaged file on mining-1) have none.
 */
export const WORLD = {
  found: 80_624_000n, inventory: 324_000n, enderChest: 80_300_000n,
  legacy: 50_000_000n, // old-world: Tavrik's five $100'000 notes, the corrected count of that save
} as const;

function playerFiles(master: string, slaves: string[], legacy: string) {
  // Quenby: a shulker of notes in the ender chest, a bundle in the inventory, a renamed note the bank would refuse, diamonds.
  playerFile(master, 'Quenby', playerNbt(
    [bundleOf([note(100, 30)]), stackOf('banksystem:money1000', 1, { 'minecraft:custom_name': str('"Lucky note"') }), stackOf('minecraft:diamond', 64)],
    [shulkerOf([note(100000, 6), stackOf('minecraft:dirt', 12)]), note(100000, 1)]));
  playerFile(master, 'Mikko_82', playerNbt([stackOf('minecraft:dirt', 64), stackOf('minecraft:wheat', 32)], []));
  playerFile(master, 'AdmiralNoor', playerNbt([note(100, 2)], []));
  // Brindle: the layout before 1.20.5 (Count as a byte, a shulker's items under tag.BlockEntityTag.Items).
  const old = (id: string, count: number, tag?: Stack) => ({ id: str(id), Count: byte(count), ...(tag ? { tag: comp(tag) } : {}) });
  playerFile(master, 'Brindle', nbtFile({ DataVersion: int(3465), Inventory: slots([old('banksystem:money', 40)]),
    EnderItems: slots([old('minecraft:shulker_box', 1, { BlockEntityTag: comp({ Items: slots([old('banksystem:money1000', 3)]) }) })]) }));
  playerFile(master, 'Tavrik', playerNbt([note(100000, 50)], []), '.dat_old'); // a backup Minecraft keeps: not read
  fs.writeFileSync(path.join(master, 'playerdata', 'notes.dat'), playerNbt([note(100000, 50)], [])); // no UUID name: not read
  // mining-1: Mikko_82's ender chest there; Quenby's file cut off, Ombrelune's not NBT at all.
  playerFile(slaves[0]!, 'Mikko_82', playerNbt([], [note(100000, 1)]));
  const cut = playerNbt([note(100000, 9)], []);
  playerFile(slaves[0]!, 'Quenby', cut.subarray(0, cut.length >> 1));
  playerFile(slaves[0]!, 'Ombrelune', Buffer.from('not a player file'));
  // nether-hub keeps no player files (its copy was taken without them).
  playerFile(legacy, 'Tavrik', playerNbt([note(100000, 5)], []));
}

// ---- Region files (AT-36): Anvil files as Minecraft 1.21 writes them, with the cases the scan must handle.

/** A chunk's sectors: [4-byte length][1-byte packing][data]; length overrides the true one to break the format. */
interface RegionChunk { index: number; body: Buffer; length?: number }
/** One region file: the 8 KiB header of offsets and sector counts, then each chunk in whole 4 KiB sectors. */
export function regionFile(file: string, chunks: RegionChunk[]) {
  const header = Buffer.alloc(8192), parts: Buffer[] = [header];
  let sector = 2;
  for (const c of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(c.length ?? c.body.length);
    const sectors = Math.ceil((4 + c.body.length) / 4096);
    header.writeUInt32BE(((sector << 8) | sectors) >>> 0, c.index * 4);
    parts.push(Buffer.concat([len, c.body], sectors * 4096));
    sector += sectors;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
}
/** A chunk's NBT packed: 1 gzip, 2 zlib, 3 none; 128 + packing keeps it in an .mcc file (written by the caller). */
export const packed = (type: number, root: Record<string, Tag>) => {
  const raw = nbtFile(root, false), p = type & 127;
  return Buffer.concat([Buffer.from([type]), type & 128 ? Buffer.alloc(0) : p === 1 ? zlib.gzipSync(raw) : p === 2 ? zlib.deflateSync(raw) : raw]);
};
const block = (id: string, x: number, y: number, z: number, more: Record<string, Tag>) => comp({ id: str(id), x: int(x), y: int(y), z: int(z), ...more });
const mob = (id: string, x: number, y: number, z: number, more: Record<string, Tag>) =>
  comp({ id: str(id), Pos: nbtList([double(x), double(y), double(z)]), ...more });
const stacks = (list: Stack[]) => nbtList(list.map((s) => comp(s)));
export const chunkRoot = (blocks: Tag[]) => ({ DataVersion: int(3955), Status: str('minecraft:full'), block_entities: nbtList(blocks) });

/**
 * What the region scan finds on the master, raw money. blocks: plain notes in blocks and entities (the chest 2'000'000,
 * the shulker in the barrel 500'000, the stockpile 350'000, the terminal 100'000, the upload block 20'000, the download
 * block 3'000, the hopper in the .mcc chunk 70'000, the old chunk 1'000, the dropped note 100'000, the chest minecart
 * 50'000, the nether chest 100'000). offers: the villager's offers, prices and not counted.
 */
export const SCAN = {
  blocks: 3_294_000n, offers: 32_000n, chest: { x: -884, y: 28, z: -1024 },
  /** The master's files: overworld region and entities, the nether, the empty end file, a mod's dimension. */
  files: 5,
  /** Chunks read; the damaged ones are the broken zlib and the length past its sector. */
  chunks: { read: 6, damaged: 2, lz4: 1 },
} as const;

function regionFiles(world: string) {
  const at = SCAN.chest;
  const renamed = stackOf('banksystem:money1000', 1, { 'minecraft:custom_name': str('"Lucky note"') });
  // Chunk -56 -64 of region -2 -2 (index 8): a chest, a barrel with a shulker box, and the BankSystem blocks.
  const main = chunkRoot([
    block('minecraft:chest', at.x, at.y, at.z, { Items: slots([note(1000, 20), stackOf('minecraft:diamond', 64), stackOf('minecraft:dirt', 64), renamed]) }),
    block('minecraft:barrel', -880, 64, -1020, { Items: slots([shulkerOf([note(100, 50)])]) }),
    block('banksystem:money_stockpile_block_entity', -878, 64, -1018, { sum: int(535), facing: str('north'), items: nbtList([
      comp({ id: short(NOTE), amount: int(30), gridSpacesPerItemType: int(1), usesGridSpaces: int(1) }),
      comp({ id: short(ITEM.money), amount: int(500), gridSpacesPerItemType: int(1), usesGridSpaces: int(2) }),
      comp({ id: short(99), amount: int(5), gridSpacesPerItemType: int(1), usesGridSpaces: int(1) })]) }),
    block('banksystem:banksystem_display_block_entity', -877, 65, -1018, { // icons only: never counted
      ovSlots: nbtList([comp({ stack: comp(note(1000000, 1)) })]), Items: slots([note(1000000, 9)]) }),
    block('banksystem:bank_terminal_block_entity', -876, 64, -1018, { banksystem: comp({ PlayerData: nbtList([comp({
      PlayerID: uuid(uuidText(PLAYERS.Quenby.n)), SelectedBankAccount: int(PLAYERS.Quenby.account),
      Inventory: comp({ Slots: nbtList([comp({ Slot: int(0), ItemStack: comp(note(100, 10)) })]) }) })]) }) }),
    block('banksystem:bank_upload_block_entity', -875, 64, -1018, { Items: stacks([note(50, 4)]), BankAccountNumber: int(PLAYERS.Mikko_82.account), SendingEnabled: byte(true) }),
    block('banksystem:bank_download_block_entity', -874, 64, -1018, { I: stacks([note(10, 3)]), A: int(PLAYERS.Mikko_82.account), P: byte(false),
      Items: stacks([note(1000000, 1)]) }), // the layout before the upgrade: read only when I is missing
  ]);
  const junk = (type: number) => Buffer.concat([Buffer.from([type]), Buffer.from('this is not packed NBT data at all')]);
  regionFile(path.join(world, 'region', 'r.-2.-2.mca'), [
    { index: 8, body: packed(2, main) },
    { index: 9, body: junk(2) }, // zlib that is not zlib: damaged
    { index: 10, body: junk(4) }, // LZ4: not read
    { index: 11, body: packed(2, chunkRoot([block('minecraft:chest', -850, 64, -1020, { Items: slots([note(1000, 99)]) })])), length: 3 * 4096 }, // a length past its sector
    { index: 12, body: packed(130, {}) }, // kept in c.-52.-64.mcc
    // Not loaded since before 1.18: Level.TileEntities, stacks with Count; packed with gzip.
    { index: 13, body: packed(1, { Level: comp({ TileEntities: nbtList([comp({ id: str('minecraft:chest'), x: int(-820), y: int(40), z: int(-1010),
      Items: nbtList([comp({ Slot: byte(0), id: str('banksystem:money5'), Count: byte(2) })]) })]) }) }) },
  ]);
  fs.writeFileSync(path.join(world, 'region', 'c.-52.-64.mcc'),
    zlib.deflateSync(nbtFile(chunkRoot([block('minecraft:hopper', -830, 64, -1020, { Items: slots([note(100, 7)]) })]), false)));
  // Entities of the same chunk: a villager with notes in its offers, a dropped note, a chest minecart with a rider.
  regionFile(path.join(world, 'entities', 'r.-2.-2.mca'), [{ index: 8, body: packed(2, { DataVersion: int(3955), Position: ints([-56, -64]), Entities: nbtList([
    mob('minecraft:villager', -880.5, 64, -1010.3, { Inventory: stacks([stackOf('minecraft:wheat', 5)]), Offers: comp({ Recipes: nbtList([
      comp({ buy: comp(stackOf('minecraft:emerald', 1)), sell: comp(note(10, 2)), maxUses: int(12), uses: int(0) }),
      comp({ buy: comp(note(100, 3)), sell: comp(stackOf('minecraft:wheat', 1)), maxUses: int(12), uses: int(3) })]) }) }),
    mob('minecraft:item', -870.2, 63, -1015.9, { Item: comp(note(1000, 1)), Age: short(100) }),
    mob('minecraft:chest_minecart', -860.5, 64, -1012.5, { Items: slots([note(100, 5)]),
      Passengers: nbtList([mob('minecraft:armor_stand', -860.5, 65, -1012.5, { HandItems: stacks([stackOf('minecraft:diamond', 3)]) })]) }),
  ]) }) }]);
  regionFile(path.join(world, 'DIM-1', 'region', 'r.0.0.mca'), [{ index: 0, body: packed(3, chunkRoot([block('minecraft:chest', 10, 70, 20, { Items: slots([note(1000, 1)]) })])) }]);
  fs.mkdirSync(path.join(world, 'DIM1', 'region'), { recursive: true });
  fs.writeFileSync(path.join(world, 'DIM1', 'region', 'r.0.0.mca'), ''); // Minecraft leaves empty files behind
  // A mod's dimension: a barrel with 1'024 diamonds and no notes.
  regionFile(path.join(world, 'dimensions', 'vaultmod', 'deep_vault', 'region', 'r.0.0.mca'), [{ index: 0, body: packed(2, chunkRoot([
    block('minecraft:barrel', 5, 30, 5, { Items: slots(Array.from({ length: 16 }, () => stackOf('minecraft:diamond', 64))) })])) }]);
}

/**
 * The bank's and the market's NBT files, with balances equal to what the bank database ends with.
 * For the old save the same layouts are written: what 2.1.2 kept in NBT is not verified.
 */
function nbtFiles(dataDir: string, bankVersion: string, balance: Map<string, bigint>, price: Map<number, number[]>) {
  const bank = path.join(dataDir, 'BankSystem'), market = path.join(dataDir, 'StockMarket', 'MarketManager');
  const itemId = (id: number) => comp({ id: short(id) });
  fs.mkdirSync(bank, { recursive: true });
  fs.writeFileSync(path.join(bank, 'ItemIDs.nbt'), nbtFile({
    formatVersion: int(1),
    itemIDs: nbtList([
      ...Object.entries(ITEM_NAME).map(([id, name]) => comp({ itemID: itemId(Number(id)), itemStack: comp({ id: str(name), count: int(1) }) })),
      comp({ itemID: itemId(VOUCHER), itemStack: comp({ id: str('banksystem:money'), count: int(1), components: comp({ 'minecraft:custom_name': str('"Gift voucher"') }) }) }),
    ]),
    itemIDAliases: nbtList([comp({ from: short(ALIAS.from), to: short(ALIAS.to) })]),
    nextShortCounter: int(ALIAS.from + 1),
  }));
  fs.writeFileSync(path.join(bank, 'Meta_data.nbt'), nbtFile({
    formatVersion: int(1), version: str(bankVersion), itemIDShortNameDigest: nbtList([comp({ s: short(GONE.id), n: str(GONE.name) })]),
  }));

  const user = (name: Name, admin: string, extra: Record<string, Tag>) =>
    comp({ userUUID: uuid(uuidText(PLAYERS[name].n)), userName: str(name), [admin]: byte(name === 'AdmiralNoor'), ...extra });
  const names = Object.keys(PLAYERS) as Name[];
  chunked(path.join(bank, 'Bank_data', 'meta'), [comp({ version: int(1), nextAccountNumber: int(Math.max(...ACCOUNT_ORDER) + 1) })], 1);
  chunked(path.join(bank, 'Bank_data', 'users'), names.map((n) => user(n, 'isBanksystemAdmin', { customData: comp({}) })), 3);

  const slot = (item: number, v: bigint) => comp({ itemID: itemId(item), balance: long(v), lockedBalance: long(0) });
  // Brindle's coal is split over the old and the current id; the reader has to add both up.
  const banks = (account: number) => nbtList([...balance].filter(([k]) => k.startsWith(`${account}:`)).flatMap(([k, v]) => {
    const item = Number(k.split(':')[1]);
    return account === PLAYERS.Brindle.account && item === ALIAS.to ? [slot(ALIAS.from, v - 3200n), slot(item, 3200n)] : [slot(item, v)];
  }));
  const users = (u: Partial<Record<Name, number>>) => nbtList(Object.entries(u).map(([n, perm]) => comp({ userUUID: uuid(uuidText(PLAYERS[n as Name].n)), permissions: int(perm) })));
  const created = long(T0 - 30 * 24 * 60 * MIN);
  const accounts = [
    ...names.map((n) => comp({ accountNumber: int(PLAYERS[n].account), accountName: str(n), createdAt: created, personalBankOwnerDataUUID: uuid(uuidText(PLAYERS[n].n)),
      creatorUUID: uuid(uuidText(PLAYERS[n].n)), users: users({ [n]: 7 }), banks: banks(PLAYERS[n].account) })),
    comp({ accountNumber: int(SHARED.account), accountName: str(SHARED.name), createdAt: created, creatorUUID: uuid(uuidText(PLAYERS.Tavrik.n)), users: users(SHARED.users), banks: banks(SHARED.account) }),
    comp({ accountNumber: int(COMPANY.account), accountName: str(COMPANY.name), createdAt: created, creatorUUID: uuid(uuidText(PLAYERS[COMPANY.founder].n)),
      users: users({ [COMPANY.founder]: 7 }), banks: banks(COMPANY.account) }),
    ...SPARE.map((s) => comp({ accountNumber: int(s.account), accountName: str(s.name), ...(s.frozen ? { frozen: byte(true) } : {}), createdAt: created,
      users: users({ [s.user]: 7 }), banks: banks(s.account) })), // never used: no slots
  ];
  chunked(path.join(bank, 'Bank_data', 'bankAccounts'), accounts, 1); // eleven files, so chunk_10 sorts wrong as text

  // ponytail: the company meta element is not in DATA_SOURCES.md; nextCompanyId is a guess the reader ignores.
  chunked(path.join(bank, 'Companies', 'meta'), [comp({ nextCompanyId: int(COMPANY.id + 1) })], 1);
  chunked(path.join(bank, 'Companies', 'companies'), [comp({ companyId: int(COMPANY.id), name: str(COMPANY.name), bankAccountNr: int(COMPANY.account) })], 1);

  chunked(path.join(market, 'users'), names.map((n) => user(n, 'isStockMarketAdmin', { preferences: comp({}) })), 4);
  chunked(path.join(market, 'markets'), [...price].map(([id, p]) => comp({
    id: short(id), currentMarketPrice: long(p.at(-1)!), defaultPrice: long(BASE_PRICE[id]!), naturalAbundance: float(1), netPlayerItemFlow: long(0),
    maintenance: byte(false), tradingOpenMinute: int(0), tradingCloseMinute: int(1440), maxOrderVolume: long(0), tradingOverride: byte(false), orderbook: comp({}),
  })), 8);
  chunked(path.join(market, 'meta'), [comp({ nextOrderId: long(1000) })], 1);
}

/**
 * One transfer per class of the cross-server check (DESIGN_SPEC 8.6), on top of the three plain deposits above. slave: the
 * index in SLAVES whose journal holds the rows (mining-1 is copied at minute 157, nether-hub 9 hours before the master).
 * The flagged ones (lost, twice, created, parked) are on players and at times that join no other finding into an incident.
 */
const tid = (n: number) => `c0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const at = (minute: number, second = 0) => T0 + minute * MIN + second * 1000;
const json = (raw: bigint, item: number = ITEM.money) => JSON.stringify({ [item]: Number(raw) });
const asked = (player: Name, ts: number, direction: string, path: string, raw: bigint, ledgerType: number | null, context: string | null) =>
  ({ ts, direction, path, step: 'REQUESTED', account_number: PLAYERS[player].account, player_uuid: uuidText(PLAYERS[player].n), items_json: json(raw), ledger_type: ledgerType, context });
const then = (ts: number, step: string, raw?: bigint, detail?: string) => ({ ts, step, items_json: raw === undefined ? null : json(raw), detail: detail ?? null });
const dropped = (player: Name, ts: number, step: string, raw: bigint, item: number = ITEM.money) =>
  ({ ts, direction: 'FROM_MASTER', path: 'DROP', step, player_uuid: uuidText(PLAYERS[player].n), items_json: json(raw, item) });
const ref = (n: number, player: Name, ts: number, amount: bigint, kind?: string, code?: number, item?: number): RefRow =>
  ({ id: tid(n), account: PLAYERS[player].account, amount, ts, player, kind, code, item });
const TIMEOUT = 'java.util.concurrent.TimeoutException';
export const TRANSFER_CASES: { id: string; class: string; slave: number | null; journal: Record<string, SQLInputValue>[]; master: RefRow[] }[] = [
  // A converter commit the master took in part: the rest went back into the converter.
  { id: tid(4), class: 'ok', slave: 0, journal: [asked('Mikko_82', at(85), 'TO_MASTER', 'CONVERTER_DEPOSIT', 500_000n, 13, 'converter'),
    then(at(85, 2), 'CONFIRMED', 300_000n), then(at(85, 3), 'RETURNED', 200_000n)], master: [ref(4, 'Mikko_82', at(85, 1), 300_000n, 'CONVERTER_DEPOSIT', 13)] },
  // The slave stopped waiting, but the master had taken the deposit.
  { id: tid(5), class: 'ok', slave: 0, journal: [asked('Brindle', at(45), 'TO_MASTER', 'ASYNC_BANK', 150_000n, 1, 'terminal'), then(at(55), 'TIMED_OUT', undefined, TIMEOUT)],
    master: [ref(5, 'Brindle', at(45, 1), 150_000n)] },
  // Banknotes dropped on the slave in part ($100 notes: their own item, money all the same); the master gave the rest back.
  { id: tid(6), class: 'ok', slave: 0, journal: [dropped('Mikko_82', at(100, 2), 'DELIVERED', 300_000n, NOTE), dropped('Mikko_82', at(100, 2), 'FAILED', 200_000n, NOTE)],
    master: [ref(6, 'Mikko_82', at(100, 1), -500_000n, 'WITHDRAW', 2), ref(6, 'Mikko_82', at(100, 3), 200_000n, 'WITHDRAW_REFUND', 6)] },
  // A withdrawal the master refused: nothing moved.
  { id: tid(7), class: 'ok', slave: 0, journal: [asked('AdmiralNoor', at(60), 'FROM_MASTER', 'ASYNC_BANK', 400_000n, 2, 'terminal')], master: [] },
  // Confirmed by the master, and the master has no row for it.
  { id: tid(8), class: 'lost', slave: 0, journal: [asked('AdmiralNoor', at(25), 'TO_MASTER', 'ASYNC_BANK', 250_000n, 1, 'terminal'), then(at(25, 2), 'CONFIRMED')], master: [] },
  // Paid in once on the slave, credited twice on the master.
  { id: tid(9), class: 'twice', slave: 0, journal: [asked('Ombrelune', at(10), 'TO_MASTER', 'ASYNC_BANK', 70_000n, 1, 'terminal'), then(at(10, 2), 'CONFIRMED')],
    master: [ref(9, 'Ombrelune', at(10, 1), 70_000n), ref(9, 'Ombrelune', at(10, 4), 70_000n)] },
  // Banknotes dropped on the slave that the master never took from an account.
  { id: tid(10), class: 'created', slave: 0, journal: [dropped('Mikko_82', at(15), 'DELIVERED', 120_000n)], master: [] },
  // The slave stopped waiting and the master has no row: the items stay taken and an admin has to sort it out.
  { id: tid(11), class: 'parked', slave: 0, journal: [asked('Brindle', at(80), 'TO_MASTER', 'ASYNC_BANK', 90_000n, 1, 'terminal'), then(at(90), 'TIMED_OUT', undefined, TIMEOUT)],
    master: [] },
  // A raw call (no ledger type): the master logs it without the id.
  { id: tid(12), class: 'known-gap', slave: 0, journal: [asked('Brindle', at(40), 'TO_MASTER', 'ASYNC_BANK', 30_000n, null, null), then(at(40, 2), 'CONFIRMED')], master: [] },
  // Two hours before the master's first row with a transfer id.
  { id: tid(13), class: 'data-gap', slave: 0, journal: [asked('Ombrelune', at(-120), 'TO_MASTER', 'ASYNC_BANK', 60_000n, 1, 'terminal'), then(at(-120, 2), 'CONFIRMED')],
    master: [] },
  // Only on the master, after nether-hub's copy was taken.
  { id: tid(14), class: 'after-snapshot', slave: null, journal: [], master: [ref(14, 'Mikko_82', at(115), 90_000n)] },
  // Asked two minutes before mining-1 was copied, no answer yet.
  { id: tid(15), class: 'after-snapshot', slave: 0, journal: [asked('Quenby', at(155), 'TO_MASTER', 'ASYNC_BANK', 45_000n, 1, 'terminal')], master: [] },
  // Rows no mod writes: items the tool cannot read (and that try to reach an object's prototype), an id that is no UUID.
  { id: tid(16), class: 'data-gap', slave: 0, journal: [{ ...asked('Quenby', at(150), 'TO_MASTER', 'ASYNC_BANK', 0n, 1, 'terminal'), items_json: '{"__proto__":{"x":1}}' },
    then(at(150, 2), 'CONFIRMED')], master: [] },
  // Iron paid in on the slave, credited as diamonds on the master: the same raw amount, another item. Not ok.
  { id: tid(17), class: 'twice', slave: 0, journal: [{ ...asked('AdmiralNoor', at(70), 'TO_MASTER', 'ASYNC_BANK', 0n, 1, 'terminal'), items_json: json(50_000n, ITEM.iron) },
    then(at(70, 2), 'CONFIRMED')], master: [ref(17, 'AdmiralNoor', at(70, 1), 50_000n, 'DEPOSIT', 1, ITEM.diamond)] },
  { id: 'not-a-transfer-id', class: 'ignored', slave: 0, journal: [then(at(150), 'CONFIRMED', 10n)], master: [] },
];

/**
 * NoteFlow per save (DESIGN_SPEC 8.7): minute after T0, source, player, item, a signed note count. One row of each source
 * the mods write, $100 notes among them, plus a row of an item that is no money and one of a source no mod writes.
 */
type Flow = [minute: number, source: string, player: Name, item: number, amount: number, villager?: number];
export const NOTE_FLOW: Record<'master' | 'mining-1' | 'nether-hub', Flow[]> = {
  master: [
    [52, 'banksystem:converter_out', 'Tavrik', ITEM.money, 40], [55, 'banksystem:creative_create', 'AdmiralNoor', NOTE, 5],
    [58, 'banksystem:give', 'AdmiralNoor', NOTE, 2], [62, 'stockmarket:villager_consume', 'Ombrelune', ITEM.money, -10, 901],
    [63, 'stockmarket:villager_change', 'Ombrelune', ITEM.money, 2, 901], [66, 'banksystem:creative_destroy', 'AdmiralNoor', NOTE, -1],
    [69, 'stockmarket:villager_pay', 'Ombrelune', ITEM.money, 3, 900],
  ],
  'mining-1': [
    [20, 'banksystem:converter_in', 'Brindle', ITEM.money, -12], [21, 'banksystem:converter_out', 'Brindle', NOTE, 3],
    [22, 'banksystem:give', 'Brindle', ITEM.diamond, 7], [23, 'othermod:lottery', 'Brindle', ITEM.money, 1],
  ],
  'nether-hub': [[20, 'banksystem:converter_in', 'Brindle', ITEM.money, -12]],
};
const flowRow = ([minute, source, player, item, amount, villager]: Flow): Record<string, SQLInputValue> => ({
  ts: T0 + minute * MIN, source, player_uuid: uuidText(PLAYERS[player].n), item_id: item, amount, context: villager ? 'trade' : 'converter',
  ...(villager ? { villager_uuid: uuidText(villager), dimension: 'minecraft:overworld', x: 120, y: 64, z: -340 } : {}),
});

/** When each SM-316 alert of the master was raised. */
export const ALERT = { pump: T0 + 21 * MIN + 700, profit: T0 + 40 * MIN + 700, cycle: T0 + 60 * MIN + 200, noPrice: T0 + 165 * MIN } as const;

/**
 * The master's alerts, in id order: a pump on Tavrik's diamond buys (a quarter of that minute's open), his profit over the
 * hour (at more than ten times the server's threshold: one level up), Quenby's emerald cycle, and a pump in a minute without
 * a price, on the old coal id, with order ids no mod writes.
 */
function tradeAlerts(price: Map<number, number[]>, list: Order[]): Record<string, SQLInputValue>[] {
  const tav = uuidText(PLAYERS.Tavrik.n);
  const firstBuy = list.find((o) => o.player === 'Tavrik' && o.amount > 0n)!, firstSell = list.find((o) => o.player === 'Tavrik' && o.amount < 0n)!;
  const lastSell = list.findLast((o) => o.player === 'Quenby')!;
  return [
    { id: 1, ts: ALERT.pump, kind: 'pump_dump_pump', player_uuid: tav, account_number: PLAYERS.Tavrik.account, item_id: ITEM.diamond,
      amount: BigInt(price.get(ITEM.diamond)![21]!) / 4n, window_ms: null, threshold: 20, text: 'Tavrik pushed the diamond price up into own sell orders',
      order_ids: `${firstBuy.id},${firstSell.id}` },
    { id: 2, ts: ALERT.profit, kind: 'profit', player_uuid: tav, account_number: null, item_id: null, amount: 555_000_000n, window_ms: 3_600_000, threshold: 50_000,
      text: 'Tavrik made 5550000.00 profit within 60 min', order_ids: null },
    { id: 3, ts: ALERT.cycle, kind: 'pump_dump_cycle', player_uuid: uuidText(PLAYERS.Quenby.n), account_number: PLAYERS.Quenby.account, item_id: ITEM.emerald,
      amount: 15_000_000n, window_ms: 1_800_000, threshold: 100_000, text: 'Quenby bought and sold emerald within 30 min', order_ids: String(lastSell.id) },
    { id: 4, ts: ALERT.noPrice, kind: 'pump_dump_pump', player_uuid: uuidText(PLAYERS.Ombrelune.n), account_number: PLAYERS.Ombrelune.account, item_id: ALIAS.from,
      amount: 30n, window_ms: null, threshold: 20, text: 'Ombrelune pushed the coal price up', order_ids: '12,abc' },
  ];
}

/** The audit export: folder name (server local time), when it was made, what its manifest records. */
export const EXPORT = { folder: '20261104-134400-before-wipe', ms: T0 + (MINUTES + 4) * MIN, bank: '2.3.0', market: '1.9.0', missing: 'data/BankSystem/Database/dividend_history.db' } as const;

/** manifest.json as BS AuditExporter.java writes it: every file of the package with its size and sha256, and one the server did not have. */
function auditManifest(dir: string) {
  const files = (fs.readdirSync(path.join(dir, 'data'), { recursive: true }) as string[]).map((f) => path.join('data', f).replaceAll('\\', '/'))
    .filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
  const entry = (f: string) => {
    const body = fs.readFileSync(path.join(dir, f));
    return { path: f, method: f.endsWith('.db') ? 'vacuum_into' : 'file_copy', size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
  };
  const part = (prefix: string) => files.filter((f) => f.startsWith(prefix)).map(entry);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format: 1, created_utc: new Date(EXPORT.ms).toISOString(), server_uid: MASTER_UID, role: 'master', minecraft_version: MINECRAFT, loader: 'neoforge',
    mods: { banksystem: EXPORT.bank, modutilities: '1.4.0', stockmarket: EXPORT.market },
    participants: {
      banksystem: { files: [...part('data/BankSystem/'), ...part('data/ModUtilities/'), { path: EXPORT.missing, method: 'missing' }] },
      stockmarket: { files: part('data/StockMarket/') },
    },
  }, null, 2));
}

export interface Fixtures {
  root: string;
  master: string;
  slaves: string[];
  legacy: string;
  /** An audit export of the master (BS-255): its data folder and a manifest, no level.dat. */
  exported: string;
  /** Rows written per save and table, for tests to compare against. */
  rows: Record<string, Record<string, number>>;
  /** Final balance per "account:item" (alias already resolved) of the master and the old save. */
  balances: Record<'master' | 'legacy', Map<string, bigint>>;
  /** level.dat's LastPlayed per save folder name. */
  lastPlayed: Record<string, number>;
}

/** flow: Tavrik's money besides the pump (FLOW), for the money flow's tests only, so no other test's figures move. */
export function buildFixtures(root: string, flow = false): Fixtures {
  fs.rmSync(root, { recursive: true, force: true });
  const price = prices(), list = orders(price, flow);
  const rows: Fixtures['rows'] = {};

  // Deposits made on a slave. Each has journal rows on the slave and a ledger row on the master with the same id.
  const transfers = [
    { id: 'c0000000-0000-4000-8000-000000000001', slave: 0, account: PLAYERS.Brindle.account, amount: 1_200_000n, ts: T0 + 30 * MIN, player: 'Brindle' as Name },
    { id: 'c0000000-0000-4000-8000-000000000002', slave: 0, account: PLAYERS.Mikko_82.account, amount: 640_000n, ts: T0 + 95 * MIN, player: 'Mikko_82' as Name },
    { id: 'c0000000-0000-4000-8000-000000000003', slave: 1, account: PLAYERS.Brindle.account, amount: 80_000n, ts: T0 + 110 * MIN, player: 'Brindle' as Name },
  ];

  // The master: bank and market data, both diagnostics files, identity.
  const master = path.join(root, 'survival-main'), data = path.join(master, 'data');
  // BS-256: a row made for a slave's request names the slave. The one only on the master came from nether-hub.
  const masterBank = bankDatabase(data, false, list, [...transfers.map((t) => ({ ...t, server: SLAVES[t.slave]!.name })),
    ...TRANSFER_CASES.flatMap((c) => c.master.map((r) => ({ ...r, server: SLAVES[c.slave ?? 1]!.name })))], flow);
  rows.master = { ...marketDatabase(data, false, price, list), ...masterBank.counts };
  nbtFiles(data, '2.2.0', masterBank.balance, price);
  identity(data, { server_uid: MASTER_UID, role: 'MASTER', slave_id: '', master_uid: '', first_start_ms: T0 - 100 * 24 * 60 * MIN,
    known_slaves: Object.fromEntries(SLAVES.map((s) => [s.name, { uid: s.uid, last_seen_ms: T0 + MINUTES * MIN }])) });
  let db = database(path.join(data, 'BankSystem/Database/banksystem_diagnostics.db'), [SQL.meta, SQL.transferJournal, SQL.noteFlow], true);
  db.insert('Meta', { key: 'created_ms', value: String(T0 - 15 * 24 * 60 * MIN) });
  db.insert('Meta', { key: 'schema_version', value: '1' });
  db.insert('Meta', { key: 'bank_last_save_ms', value: String(LAST_SAVE) });
  // The bank's own flag thresholds: one changed, one invalid (left at its default), the rest default.
  fs.writeFileSync(path.join(data, 'BankSystem', 'settings.json'), JSON.stringify({ Utilities: { STARTING_BALANCE: 0 },
    Audit: { LAUNDERING_MIN_AMOUNT: 2_000_000, WEALTH_JUMP_PERCENT: 'lots' } }, null, 2));
  auditLog(data);
  for (const f of NOTE_FLOW.master) db.insert('NoteFlow', flowRow(f));
  Object.assign(rows.master, db.close());
  db = database(path.join(data, 'StockMarket/Database/stockmarket_diagnostics.db'), [SQL.meta, SQL.orderOrigin, SQL.tradeAlert], true);
  db.insert('Meta', { key: 'created_ms', value: String(T0 - 15 * 24 * 60 * MIN) });
  db.insert('Meta', { key: 'schema_version', value: '2' });
  for (const o of list) db.insert('OrderOrigin', { ref: `sm:order:${o.id}`, origin_server_uid: o.player === 'Brindle' ? SLAVES[0]!.uid : MASTER_UID, origin_name: o.player === 'Brindle' ? SLAVES[0]!.name : '' });
  for (const a of tradeAlerts(price, list)) db.insert('TradeAlert', a);
  const marketDiag = db.close();
  rows.master.OrderOrigin = marketDiag.OrderOrigin!; // Meta exists in both diagnostics files; the bank's count stays
  rows.master.TradeAlert = marketDiag.TradeAlert!;

  // The slaves: only the bank's diagnostics file and the identity.
  const slaves = SLAVES.map((s, i) => {
    const dir = path.join(root, s.name), slaveData = path.join(dir, 'data');
    identity(slaveData, { server_uid: s.uid, role: 'SLAVE', slave_id: s.name, master_uid: MASTER_UID, first_start_ms: T0 - 30 * 24 * 60 * MIN });
    const d = database(path.join(slaveData, 'BankSystem/Database/banksystem_diagnostics.db'), [SQL.meta, SQL.transferJournal, SQL.noteFlow], true);
    d.insert('Meta', { key: 'created_ms', value: String(T0 - 10 * 24 * 60 * MIN) });
    d.insert('Meta', { key: 'schema_version', value: '1' });
    for (const t of transfers.filter((x) => x.slave === i)) {
      d.insert('TransferJournal', { transfer_id: t.id, ts: t.ts - 40, direction: 'TO_MASTER', path: 'ASYNC_BANK', step: 'REQUESTED', account_number: t.account,
        player_uuid: uuidText(PLAYERS[t.player].n), items_json: JSON.stringify({ [ITEM.money]: Number(t.amount) }), ledger_type: 1, context: 'terminal' });
      d.insert('TransferJournal', { transfer_id: t.id, ts: t.ts + 15, step: 'CONFIRMED' });
    }
    for (const c of TRANSFER_CASES.filter((x) => x.slave === i)) for (const j of c.journal) d.insert('TransferJournal', { transfer_id: c.id, ...j });
    for (const f of NOTE_FLOW[s.name as 'mining-1' | 'nether-hub']) d.insert('NoteFlow', flowRow(f));
    rows[s.name] = d.close();
    return dir;
  });

  // The old save: thin bank log, no trade rows, no flags, no diagnostics, no identity file.
  const legacy = path.join(root, 'old-world'), legacyData = path.join(legacy, 'data');
  const legacyBank = bankDatabase(legacyData, true, list, [], flow);
  rows.legacy = { ...marketDatabase(legacyData, true, price, list), ...legacyBank.counts };
  nbtFiles(legacyData, '2.1.2', legacyBank.balance, price);

  // When each copy was taken: the slaves shortly before the master, except nether-hub, copied 9 hours earlier. The old
  // save an hour after the master, so its copy, too, comes after everything it holds (AT-40: the flow runs up to it).
  const end = T0 + MINUTES * MIN + 2 * MIN;
  const lastPlayed = { 'survival-main': end, 'mining-1': end - 5 * MIN, 'nether-hub': end - 9 * 60 * MIN, 'old-world': end + 60 * MIN };
  for (const dir of [master, ...slaves, legacy]) levelDat(dir, lastPlayed[path.basename(dir) as keyof typeof lastPlayed]);
  playerFiles(master, slaves, legacy);
  regionFiles(master);

  const exported = path.join(root, 'exports', EXPORT.folder);
  fs.cpSync(data, path.join(exported, 'data'), { recursive: true });
  auditManifest(exported);

  return { root, master, slaves, legacy, exported, rows, balances: { master: masterBank.balance, legacy: legacyBank.balance }, lastPlayed };
}

/**
 * Cases for Connected players (AT-41), written into a copy of the current master by addLinkCases. Brindle pays in exactly
 * the notes Tavrik withdrew a minute before (Likely). Brindle and Mikko_82 buy coal in sessions that overlap for 3 minutes
 * (Weak). Brindle buys wheat 6 minutes after Mikko_82's lone wheat sale: two sessions that do not overlap.
 */
export const LINKS = {
  paidIn: { player: 'Brindle' as Name, amount: 200_000_000n, ts: T0 + 52 * MIN + 500 },
  coal: [['Brindle', 60], ['Mikko_82', 61], ['Brindle', 63], ['Mikko_82', 64], ['Brindle', 66]] as [Name, number][],
  wheat: { player: 'Brindle' as Name, minute: 18 },
} as const;

export function addLinkCases(save: string) {
  const bank = new DatabaseSync(path.join(save, 'data/BankSystem/Database/banksystem.db'));
  const p = LINKS.paidIn;
  bank.prepare(`INSERT INTO TransactionLog (account_number, actor_uuid, actor_name, kind, type_code, item_id, amount, ts, source_kind)
    VALUES (?, ?, ?, 'DEPOSIT', 1, ?, ?, ?, 'PLAYER')`).run(PLAYERS[p.player].account, uuidText(PLAYERS[p.player].n), p.player, ITEM.money, p.amount, p.ts);
  bank.close();
  const market = new DatabaseSync(path.join(save, 'data/StockMarket/Database/stockdata.db'));
  const order = market.prepare(`INSERT INTO OrderHistory (itemid, accountid, userid_one, userid_two, type, amount, price, time) VALUES (?, ?, ?, ?, 0, 3200, 120, ?)`);
  const add = (who: Name, item: number, minute: number) => order.run(item, PLAYERS[who].account, ...uuidHalves(PLAYERS[who].n), T0 + minute * MIN);
  for (const [who, minute] of LINKS.coal) add(who, ITEM.coal, minute);
  add(LINKS.wheat.player, ITEM.wheat, LINKS.wheat.minute);
  market.close();
}

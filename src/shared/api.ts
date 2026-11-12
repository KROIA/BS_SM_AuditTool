// What the screens may ask the engine. The screens have no other way to reach a file.
// Everything here crosses the border between two processes, so it is plain data: no classes, no functions.

/** One table of a database: rows that were read, ids that could not be, and the time span the rows cover. */
export interface SaveTable {
  name: string;
  rows: number;
  lostIds: number;
  /** The rows written last could not be read (a copy taken while the mod was writing). How many is unknown. */
  newestLost: boolean;
  from: number | null;
  to: number | null;
  /** Rows per day, for the coverage bars: [start of the UTC day in epoch ms, rows]. Days without rows are left out. */
  days: [number, number][];
}

/**
 * One data source of a save.
 * read: found and readable. damaged: found, but a part could not be read.
 * missing: should be there for this kind of save and is not. none: not there, and that is normal.
 */
export interface SaveSource {
  id: 'bank' | 'market' | 'bankDiag' | 'marketDiag';
  status: 'read' | 'damaged' | 'missing' | 'none';
  bytes: number;
  tables: SaveTable[];
}

export interface SaveSummary {
  /** The folder the user picked. */
  path: string;
  /** The slave's name, or the folder name. */
  name: string;
  role: 'MASTER' | 'SLAVE' | 'STANDALONE';
  /** True when there is no identity file and the role was worked out from the files found. */
  roleAssumed: boolean;
  serverUid: string | null;
  /** For a slave: the id of the master it belongs to. */
  masterUid: string | null;
  /** legacy: mod version 2.1.2, before the audit additions. */
  generation: 'legacy' | 'current';
  /** When the world was last played (level.dat), which is when the copy was taken at the latest. */
  lastPlayedMs: number | null;
  minecraft: string | null;
  /** The BankSystem version that wrote the save, when its files say so. */
  bankVersion: string | null;
  /** How many players and bank accounts the save's files list. */
  players: number;
  accounts: number;
  sources: SaveSource[];
  warnings: string[];
}

/** The loaded saves of one network, and what is odd about how they fit together. */
export interface Workspace {
  saves: SaveSummary[];
  warnings: string[];
}

/** Sent while a save is being read. */
export interface Progress {
  save: string;
  step: string;
  done: number;
  total: number;
}

/**
 * What every question about the data is limited to (DESIGN_SPEC section 5): the time range and the server filter
 * of the top bar. Times are epoch ms; null leaves that end open. server is a save's name; null means all servers.
 */
export interface Scope {
  from: number | null;
  to: number | null;
  server: string | null;
}

export interface EngineCheck {
  node: string;
  sqlite: string;
  /** 2^63 - 1, sent through every border to prove that 64-bit numbers arrive intact. */
  largest: bigint;
}

// ---- Questions about the data (milestone M1). Amounts are raw (real x 100) and bigint; row ids and account numbers fit a number.

/** A value over time, for charts: [epoch ms, raw value]. */
export type Point = [number, bigint];

export interface ItemRow {
  id: number;
  /** As in ItemIDs.nbt, for example "minecraft:diamond". The screens shorten it for display. */
  name: string;
  money: boolean;
}

/** One finished player order (OrderHistory). */
export interface OrderRow {
  id: number;
  /** null on old rows and on inter-market legs. */
  orderId: number | null;
  item: number;
  account: number;
  /** Player UUID, lower case with dashes. */
  player: string;
  type: 'market' | 'limit' | 'intermarket';
  /** Filled volume, raw, signed: + bought, - sold. */
  amount: bigint;
  /** Average execution price, raw money per whole item. */
  price: bigint;
  /** Money of the order (DESIGN_SPEC 8.1): amount x price / 100, cut off like the mod does it. Signed like amount. */
  money: bigint;
  /** When the order was placed. 0 when the save has no time for it. */
  time: number;
  /** When the order finished (SM-317, epoch ms). null on saves before it. */
  finishMs: number | null;
  /** The save where it was placed (OrderOrigin); null when the save does not say. */
  server: string | null;
}

/** One row of the bank's log (TransactionLog). */
export interface LedgerRow {
  id: number;
  time: number;
  account: number;
  /** The type's name as stored, for example "TRADE_BUY". 2.1.2 saves have names only, no codes. */
  kind: string;
  item: number;
  /** As stored. Unsigned for most types (DATA_SOURCES.md, sign rules). */
  amount: bigint;
  /** What the row did to the balance: + in, - out. null when the direction is unknown (ADMIN_SET without a readable note, old unsigned payouts). */
  change: bigint | null;
  /** Trade rows move two balances: item and change above are the goods, this is the money side (currency_item, money_amount). null on other rows. */
  money: { item: number; change: bigint } | null;
  actor: string | null;
  actorName: string | null;
  sourceKind: string | null;
  otherAccount: number | null;
  /** Free plus locked after the change. null on trade rows and 2.1.2 rows. */
  balanceAfter: bigint | null;
  ref: string | null;
  note: string | null;
}

/** Realised profit per item with the average cost method (DESIGN_SPEC 8.1). Sales within the scope; purchases before it count for the cost. */
export interface MarketProfit {
  item: number;
  orders: number;
  /** Money spent and received, raw, both positive. */
  bought: bigint;
  sold: bigint;
  profit: bigint;
  /** Money received for items the player had not bought on the market. Not part of profit. */
  soldWithoutPurchase: bigint;
}

export interface PlayerRow {
  uuid: string;
  name: string;
  orders: number;
  profit: bigint;
  /** First and last order or ledger row of the player in the scope. */
  firstMs: number | null;
  lastMs: number | null;
}

export interface PlayerAccount {
  number: number;
  name: string;
  company: string | null;
  owner: boolean;
  /** Permission bits DEPOSIT=1 WITHDRAW=2 MANAGE=4 for a user who is not the owner. */
  permissions: number | null;
}

export interface PlayerDetail extends PlayerRow {
  accounts: PlayerAccount[];
  /** Money on the accounts the player owns, from the bank's files (the state of the copy, not of the scope). */
  moneyNow: bigint;
  markets: MarketProfit[];
  /** Money on the owned accounts over time: per account the last snapshot at or before each point, summed (DESIGN_SPEC 8.1). */
  money: Point[];
}

export interface AccountRow {
  number: number;
  name: string;
  company: string | null;
  frozen: boolean;
  owner: string | null;
  ownerName: string | null;
  /** Money on the account, from the bank's files. */
  money: bigint;
  /** Ledger rows of the account in the scope. */
  rows: number;
}

export interface AccountDetail extends AccountRow {
  createdMs: number | null;
  users: { uuid: string; name: string; permissions: number }[];
  /** Every item slot, from the bank's files. */
  items: { item: number; balance: bigint; locked: bigint }[];
}

export interface MarketRow {
  item: number;
  /** The current price from MarketManager, raw. */
  price: bigint | null;
  /** Highest high divided by lowest low of the candles in the scope; null without candles. */
  swing: number | null;
  orders: number;
}

export interface MarketFacts {
  /** DESIGN_SPEC 8.1: median open of the 1-minute candles in the scope, else the median order price. */
  usual: bigint | null;
  low: bigint | null;
  high: bigint | null;
  /** Summed candle volume. It mixes players, the price bot and the virtual order book. */
  volume: number;
  traders: number;
}

/** A candle. The mods store no close: it is the next candle's open, null for the newest. */
export interface Candle {
  time: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint | null;
  volume: number;
}

export interface Trader {
  uuid: string;
  name: string;
  bought: bigint;
  sold: bigint;
  profit: bigint;
}

/** Orders of one player less than 5 minutes apart (DESIGN_SPEC 8.1). Times are when the orders were placed. */
export interface Session {
  start: number;
  end: number;
  orders: number;
  /** Item ids, in the order they were first traded. */
  markets: number[];
  /** Realised profit of the session's sales; the average cost carries over from every earlier trade. */
  profit: bigint;
  soldWithoutPurchase: bigint;
  /** Median time between neighbouring orders; null for a session of one order. */
  medianGapMs: number | null;
}

export interface SearchResult {
  players: { uuid: string; name: string }[];
  accounts: { number: number; name: string }[];
  items: ItemRow[];
  /** With the name of the player who placed it. Transfer ids are not searched until they have a screen (M4). */
  orders: (OrderRow & { name: string })[];
}

/**
 * The questions the screens of M1 ask. Each package adds the methods it builds to EngineApi with
 * `extends Pick<QueryApi, ...>`. Every method that takes a Scope honours its time range; the server filter applies
 * to orders (by OrderOrigin) and is ignored by bank data, which exists only on the master.
 */
export interface QueryApi {
  items(): ItemRow[];
  /** Sorted by profit, highest first (by suspicion from M2 on). */
  players(scope: Scope): PlayerRow[];
  player(uuid: string, scope: Scope): PlayerDetail | null;
  /** Newest first. */
  orders(filter: { player?: string; item?: number }, scope: Scope): OrderRow[];
  /** Newest first. */
  ledger(filter: { accounts: number[] }, scope: Scope): LedgerRow[];
  /** Sorted by money, highest first (by the unexplained amount from M2 on). */
  accounts(scope: Scope): AccountRow[];
  account(number: number, scope: Scope): AccountDetail | null;
  /** Snapshots of one account and item: free plus locked. */
  balances(account: number, item: number, scope: Scope): Point[];
  /** Sorted by swing, largest first (by findings from M2 on). */
  markets(scope: Scope): MarketRow[];
  market(item: number, scope: Scope): MarketFacts;
  /** At most 5'000 candles; capped says that the scope held more and should be narrowed. */
  candles(item: number, minutes: 1 | 5 | 15 | 60 | 1440, scope: Scope): { candles: Candle[]; capped: boolean };
  /** Sorted by profit, highest first. */
  traders(item: number, scope: Scope): Trader[];
  /** At most 5 hits per group. */
  search(text: string): SearchResult;
  /** The sessions that overlap the time range, whole, oldest first. Only orders of the filtered server form sessions. */
  sessions(uuid: string, scope: Scope): Session[];
}

export interface EngineApi extends Pick<QueryApi, 'items' | 'players' | 'player' | 'orders' | 'ledger' | 'accounts' | 'account' | 'balances' | 'markets' | 'market' | 'candles' | 'traders' | 'search' | 'sessions'> {
  /** The saves of the last session, read again only where they changed on disk. */
  workspace(): Workspace;
  addSave(path: string): Workspace;
  removeSave(path: string): Workspace;
  selfCheck(): EngineCheck;
}

/** The same calls as the screens see them: every answer arrives later. */
export type RemoteEngine = { [K in keyof EngineApi]: (...args: Parameters<EngineApi[K]>) => Promise<ReturnType<EngineApi[K]>> };

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
  /** audit: the bank's audit log files, one table AuditLog with an entry per row. */
  id: 'bank' | 'market' | 'bankDiag' | 'marketDiag' | 'audit';
  status: 'read' | 'damaged' | 'missing' | 'none';
  bytes: number;
  tables: SaveTable[];
  /** A sentence about how the source was read, e.g. the audit log's time zone. */
  note?: string;
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
  /**
   * For a master: the ids of the slaves it knows (server_identity.json, known_slaves). null when the file does not list
   * them; a summary cached before this field existed has none either, so read it as `?? null`.
   */
  knownSlaves: string[] | null;
  /** legacy: mod version 2.1.2, before the audit additions. */
  generation: 'legacy' | 'current';
  /** When the world was last played (level.dat), which is when the copy was taken at the latest. */
  lastPlayedMs: number | null;
  minecraft: string | null;
  /** The BankSystem version that wrote the save, when its files say so. */
  bankVersion: string | null;
  /** The StockMarket version: only an audit export's manifest records it. Read as `?? null` on older cached summaries. */
  marketVersion?: string | null;
  /**
   * An audit export (BS-255, `/banksystem backup export`) rather than a copy of the world folder. Its lastPlayedMs is when
   * it was made (manifest created_utc). Missing on older cached summaries.
   */
  exported?: boolean;
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

/** Sent while a save is being read, and by the region scan after each file (with scan set; done and total count files). */
export interface Progress {
  save: string;
  step: string;
  done: number;
  total: number;
  scan?: ScanStatus;
}

/**
 * How much of the region files the scan has read (DESIGN_SPEC 6.7). Files and bytes are those on disk now; a file is done
 * when the scan read it at its current size and time, so a changed file counts as not done.
 */
export interface ScanCoverage {
  state: 'no region files' | 'not run' | 'partial' | 'complete';
  files: number;
  filesTotal: number;
  bytes: number;
  bytesTotal: number;
  /** Chunks read in the files done. */
  chunks: number;
  /** What could not be read in the files done: whole files, and chunks damaged, packed with LZ4 (not read) or too large. */
  unreadable: { files: number; damaged: number; lz4: number; tooLarge: number };
  /** Finds not kept because the save reached the row limit of the cache. */
  dropped: number;
}
export interface ScanStatus extends ScanCoverage {
  running: boolean;
  /** Raw money in plain notes the scan found in blocks and entities so far (offers left out). */
  notes: bigint;
  /** Per loaded save, in the order they were added. */
  saves: ({ save: string } & ScanCoverage)[];
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
  /** SM-317: the limit price, raw money per whole item; 0 for a market order. null on saves before it. */
  limitPrice: bigint | null;
  /** SM-317: the volume the player asked for, raw, signed like amount. null on saves before it. */
  wanted: bigint | null;
  /** SM-317: how the order ended. null on saves before it. */
  status: 'filled' | 'cancelled by the player' | 'cancelled by the server' | null;
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
  /**
   * BS-256: the save the change was made on (the master's name for rows the master made). null when the save's log has no
   * origin column: such rows show under every server filter.
   */
  server: string | null;
  /** BS-258: where the player stood, for rows the mod placed. null when it has no place. */
  place: { dimension: string; x: number; y: number; z: number } | null;
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
  /** Gone from the bank's files, still in the snapshots or the log. Its name is empty, it has no owner, users or slots. */
  deleted: boolean;
}

/** An account in the list, with what the check per account (DESIGN_SPEC 8.4) found in the scope. */
export interface AccountListRow extends AccountRow {
  /** Money the log does not explain: the size of each gap above the threshold, summed (gaps that cancel each other both count). */
  unexplained: bigint;
  /** Gaps above the threshold, of every item. */
  gaps: number;
  /** The highest rating of those gaps; null without one. */
  rating: Rating | null;
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
  /** Lowest low and highest high of the candles in the scope; null without candles. */
  low: bigint | null;
  high: bigint | null;
  orders: number;
}

export interface MarketFacts {
  /** DESIGN_SPEC 8.1: the usual price at the end of the scope (median open of the last 1'440 minutes before its hour). */
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

/** How much a gap says (DESIGN_SPEC 8.4): low on a legacy save, high after the first BS-254 row, else medium. */
export type Rating = 'low' | 'medium' | 'high';

/** A time between two snapshots in which the balance moved by more or less than the log explains. */
export interface Gap {
  from: number;
  to: number;
  /** Actual change minus explained change, raw: + the balance gained more than the log says. */
  difference: bigint;
  /** Kinds of the rows in the gap whose sign the save does not give (ADMIN_SET without a readable note, older payouts). */
  labels: string[];
  rating: Rating;
  /** The balance at `to`, free plus locked. */
  after: bigint;
}

/**
 * The check of one item on one account (DESIGN_SPEC 8.4), from the first to the last snapshot in the scope:
 * start + trades + paidIn - paidOut = shouldBe, next to is. Amounts raw. start, shouldBe and is are null without a snapshot.
 */
export interface ItemCheck {
  item: number;
  /** When the first and the last snapshot in the scope were taken; null without a snapshot. */
  from: number | null;
  to: number | null;
  start: bigint | null;
  /** Signed: + goods or money received from trades, - given. */
  trades: bigint;
  paidIn: bigint;
  paidOut: bigint;
  shouldBe: bigint | null;
  is: bigint | null;
  /** is - shouldBe: every difference, also those below the threshold. */
  unexplained: bigint;
  /** Only the gaps whose difference is above the "Balance not explained" threshold. */
  gaps: Gap[];
  /**
   * unchecked: fewer than two snapshots in the scope. explained: no gap above the threshold. unexplained: at least one gap
   * no row can explain. unknown-rows: every gap holds a row whose sign the save does not give.
   */
  verdict: 'unchecked' | 'explained' | 'unexplained' | 'unknown-rows';
}

// ---- Findings (DESIGN_SPEC 8.2). Money thresholds are raw (real x 100), item thresholds raw too (count x 100).

export type RuleId = 'round-trip' | 'order-rate' | 'hour-profit' | 'far-price' | 'price-spike' | 'balance' | 'order-ledger' | 'bank-flag' | 'last-save'
  | 'market-alert' | 'transfer' | 'banknotes';
export type Level = 'low' | 'medium' | 'high' | 'critical';

/** Each rule on or off, with its thresholds. Turned off, a rule is not run. */
export interface RuleSettings {
  'round-trip': { on: boolean; times: number; seconds: number };
  'order-rate': { on: boolean; orders: number };
  'hour-profit': { on: boolean; money: bigint };
  'far-price': { on: boolean; times: number };
  'price-spike': { on: boolean; times: number };
  'balance': { on: boolean; money: bigint; items: bigint };
  'order-ledger': { on: boolean };
  'bank-flag': { on: boolean };
  'last-save': { on: boolean };
  'market-alert': { on: boolean };
  'transfer': { on: boolean };
  'banknotes': { on: boolean; money: bigint };
}
export const DEFAULT_RULES: RuleSettings = {
  'round-trip': { on: true, times: 2, seconds: 30 },
  'order-rate': { on: true, orders: 5 },
  'hour-profit': { on: true, money: 100_000_000n },
  'far-price': { on: true, times: 10 },
  'price-spike': { on: true, times: 5 },
  'balance': { on: true, money: 100_000n, items: 100_000n },
  'order-ledger': { on: true },
  'bank-flag': { on: true },
  'last-save': { on: true },
  'market-alert': { on: true },
  'transfer': { on: true },
  'banknotes': { on: true, money: 10_000_000n },
};

/** One value of a finding's facts. Which keys a rule fills is listed at the rule in engine/query/findings.ts. */
export type Fact = string | number | bigint | boolean | null | string[];

export interface Finding {
  /** rule:key. The key is built from the data alone, so the same data and settings give the same id (pins and dismissals point at it). */
  id: string;
  rule: RuleId;
  level: Level;
  basis: 'proven' | 'estimate' | 'hint' | 'as raised';
  source: 'tool' | 'bank mod' | 'market mod';
  start: number;
  end: number;
  players: { uuid: string; name: string }[];
  markets: number[];
  accounts: number[];
  /** Where its orders were placed; empty for bank data, which shows under every server filter. */
  servers: string[];
  /** The most extreme value of the finding against the rule's threshold (null: the rule has none, or the server's setting is unknown). */
  measured: { value: number | bigint; threshold: number | bigint | null; unit: 'times' | 'orders' | 'money' | 'items' | 'shares' | 'rows' | 'percent' };
  facts: Record<string, Fact>;
  records: { orders: number[]; ledger: number[]; flags: number[]; candles: { market: number; time: number }[] };
  /** Bank mod flags only: acknowledged by an admin. null for every other rule. */
  acknowledged: boolean | null;
}

export interface RuleStatus {
  rule: RuleId;
  on: boolean;
  /** Findings over all loaded data; null when the rule did not run. */
  found: number | null;
  /** Why the rule does not apply to this save; null when it does. */
  notApplicable: string | null;
}

export interface FindingsResult {
  findings: Finding[];
  rules: RuleStatus[];
  /** The bank mod's flag settings from the save's settings.json ("Audit" group, whole money units), defaults filled in. Shown, never changed. */
  bankSettings: Record<string, number | boolean>;
}

/**
 * Findings that belong together (DESIGN_SPEC 8.5): they share a player or a market and lie less than 30 minutes apart,
 * also through other findings. Its title and sentence are made from these figures (shared/incident.ts).
 */
export interface Incident {
  /** The id of its earliest finding. */
  id: string;
  /** The highest of its findings. */
  level: Level;
  start: number;
  end: number;
  /** Of its findings, plus the owner of each personal account they name. Sorted by name. */
  players: { uuid: string; name: string }[];
  markets: number[];
  accounts: number[];
  servers: string[];
  /** Its findings' ids, oldest first. */
  findings: string[];
  /** Realised profit of its players on its markets within its span, raw money. */
  profit: bigint;
}

export interface IncidentsResult {
  /** Strongest first: highest level, then largest profit. */
  incidents: Incident[];
  /** Findings not in an incident with another finding, sorted like findings(). */
  others: Finding[];
  /** Ids the case has marks for that no rule raises with these settings (a threshold changed, a rule is off). */
  orphans: string[];
}

/**
 * What the user marked on one finding, kept in case.json. title and start are copied from the finding when it is marked,
 * so the mark can still be shown when a changed threshold no longer raises the finding.
 */
export interface Mark {
  title: string;
  start: number;
  /** Pinned as evidence for the case. */
  pinned: boolean;
  /** Marked as not a problem, with an optional reason. */
  dismissed: boolean;
  reason: string;
  note: string;
}

/** The cutoff of the take-back (DESIGN_SPEC 8.10): the end of the day before the incident, right before its first finding, or a time picked (at). */
export interface Cutoff { kind: 'day' | 'first' | 'custom'; at: number | null }
/** Did an admin remove money that left a 2.1.2 account without a log row? */
export type Answer = 'yes' | 'unsure' | 'no';
/** What the Case screen remembers. answers: by removal key (TakeBackRow.removed); order: pinned finding ids, the evidence order. */
export interface CaseChoices { cutoff: Cutoff; answers: Record<string, Answer>; order: string[] }

/** The parts of case.json the screens use. */
export interface CaseData {
  rules: RuleSettings;
  /** By finding id. */
  marks: Record<string, Mark>;
  choices: CaseChoices;
}

/** One item to take back from an account (DESIGN_SPEC 8.10), raw counts: remove = max(0, min(bought, now - before)). */
export interface TakeBackItem { item: number; before: bigint; bought: bigint; spent: bigint; now: bigint; remove: bigint }
/**
 * One personal account of the take-back. start: the balance at the cutoff (the newest snapshot at or before it, else the
 * first one after it, from); other: net trading since then on markets outside the incident; keep = min(now, start +
 * max(0, other)); take = now - keep. removed: 2.1.2 money that left without a log row since the cutoff, one per gap.
 * via: for a player outside the incident, the incident player whose notes this one likely paid in after the cutoff
 * (DESIGN_SPEC 8.9) and the sum of those notes; their take = min(now, notes + max(0, net on the incident's markets)).
 * null for the incident's own players.
 */
export interface TakeBackRow {
  account: number;
  player: { uuid: string; name: string };
  via: { uuid: string; name: string; notes: bigint } | null;
  from: number | null;
  start: bigint;
  now: bigint;
  other: bigint;
  keep: bigint;
  take: bigint;
  removed: { key: string; amount: bigint; from: number; to: number }[];
  /** Largest money spent first. */
  items: TakeBackItem[];
}
/** What to take back for one incident (DESIGN_SPEC 6.8, 8.10). */
export interface TakeBack {
  /** Why nothing can be shown; null when it ran. */
  reason: string | null;
  incident: Incident | null;
  /** The moment used, and the moments of the first two cutoff cards. */
  at: number;
  day: number;
  first: number;
  rows: TakeBackRow[];
  /** Money kept as goods (the money flow's "spent on items" since the cutoff). */
  items: bigint;
  /** The notes still outside since the cutoff, and where they are (the money flow's split, all players as one). */
  notes: MoneyFlow['notes'];
  to: number | null;
  legacy: boolean;
  missing: string[];
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
  /** Sorted by profit, highest first. The Players screen puts them in the suspicion order (shared/incident.ts). */
  players(scope: Scope): PlayerRow[];
  player(uuid: string, scope: Scope): PlayerDetail | null;
  /** Newest first. ids: order ids as a finding's records hold them (the mod's order id, else the row id). */
  orders(filter: { player?: string; item?: number; ids?: number[] }, scope: Scope): OrderRow[];
  /** Newest first. Rows of the accounts, or the rows with these ids. */
  ledger(filter: { accounts?: number[]; ids?: number[] }, scope: Scope): LedgerRow[];
  /**
   * Sorted by the money the log does not explain, then by the number of gaps, then by money. Deleted accounts are in it.
   * The check counts gaps above the "Balance not explained" threshold of the settings.
   */
  accounts(scope: Scope, settings: RuleSettings): AccountListRow[];
  /** Deleted accounts too (deleted: true). */
  account(number: number, scope: Scope): AccountDetail | null;
  /** Snapshots of one account and item: free plus locked. */
  balances(account: number, item: number, scope: Scope): Point[];
  /** Sorted by swing, largest first. The Markets screen puts those with findings first. */
  markets(scope: Scope): MarketRow[];
  market(item: number, scope: Scope): MarketFacts;
  /**
   * At most 5'000 candles; capped says that the scope held more and should be narrowed. usual: the usual price at each
   * candle's start (DESIGN_SPEC 8.1, it follows the market), one per candle.
   */
  candles(item: number, minutes: 1 | 5 | 15 | 60 | 1440, scope: Scope): { candles: Candle[]; capped: boolean; usual: (bigint | null)[] };
  /** Sorted by profit, highest first. */
  traders(item: number, scope: Scope): Trader[];
  /** At most 5 hits per group. */
  search(text: string): SearchResult;
  /** The sessions that overlap the time range, whole, oldest first. Only orders of the filtered server form sessions. */
  sessions(uuid: string, scope: Scope): Session[];
  /**
   * Per item of the account, lowest item id first. Works on accounts gone from the bank's files too. A gap counts only
   * above the "Balance not explained" threshold of the settings; smaller ones are cut-off noise.
   */
  check(account: number, scope: Scope, settings: RuleSettings): ItemCheck[];
  /**
   * The rules run over all loaded data, kept per workspace and settings; this returns the findings that overlap the
   * time range, under a server filter those whose orders were placed there plus every finding without a server.
   * Sorted by level, highest first, then by time.
   */
  findings(scope: Scope, settings: RuleSettings): FindingsResult;
  /** Findings grouped over all loaded data; returns the incidents and lone findings that findings() would show for the scope. */
  incidents(scope: Scope, settings: RuleSettings): IncidentsResult;
  /** Admin actions and admin changes from the bank's audit log in the time range, oldest first. Empty without an audit log. */
  adminEvents(scope: Scope): AdminEvent[];
  /** The Overview's figures, chart and lists, without the findings (those take the first run of the rules). */
  overview(scope: Scope): Overview;
  /** The few strongest moments of the time range for the Overview's chart, oldest first. */
  keyEvents(scope: Scope, settings: RuleSettings): KeyEvent[];
  /**
   * Value moved between servers (DESIGN_SPEC 8.6): every transfer id of the slaves' journals and the master's log, newest
   * first. The time range keeps transfers that start in it; a server filter keeps that slave's and those of no known slave.
   */
  transfers(scope: Scope): TransfersResult;
  /**
   * Notes handed out by the bank minus notes paid back in, plus and minus NoteFlow on every loaded server (DESIGN_SPEC 8.7).
   * The time range limits the movements; outstanding and the series count everything up to its end. A server filter keeps
   * log rows made there (and rows without an origin) and that server's NoteFlow.
   */
  banknotes(scope: Scope): BanknotesResult;
  /**
   * The players linked to one player (DESIGN_SPEC 8.9), strongest first. The range and the server filter apply to
   * transfers, notes and sessions; a shared account is the state of the copy. At most 5 players linked by trading alone,
   * at most 3 markets per player.
   */
  links(uuid: string, scope: Scope): PlayerLink[];
  /**
   * Where the money of one incident went (DESIGN_SPEC 6.6, 8.10), for all its players (player null) or one. The time range
   * does not apply; the server filter applies to orders and trade rows (trading elsewhere becomes "other-server").
   * settings: the incidents are made from the findings, and the threshold of gaps on 2.1.2 is the balance rule's.
   */
  moneyFlow(scope: Scope, incidentId: string, player: string | null, settings: RuleSettings): MoneyFlow;
  /** What to take back from the incident's players (DESIGN_SPEC 8.10), from the cutoff to the copy. No scope applies. */
  takeBack(incidentId: string, cutoff: Cutoff, settings: RuleSettings): TakeBack;
  /**
   * What the players carry in their inventories and ender chests (DESIGN_SPEC 8.7), from the player files of the main
   * save and its loaded slaves: the state when each copy was taken, so no scope applies.
   */
  worldItems(): WorldItemsResult;
  /**
   * Starts the region scan in the background (DESIGN_SPEC 6.7) for the loaded save at this path, or all loaded saves:
   * every region file not done yet. Progress arrives as Progress with scan set. Does nothing while a scan runs.
   */
  startScan(save?: string): ScanStatus;
  /** Stops the scan; the files done are kept, and startScan continues with the rest. */
  stopScan(): ScanStatus;
  scanStatus(): ScanStatus;
}

/** Stacks of one item at one place of one player file, added up. */
export interface WorldStack {
  /** The save's name. */
  server: string;
  place: 'inventory' | 'ender chest';
  /** The containers it is in, outermost first (item ids such as minecraft:shulker_box); empty when loose. */
  path: string[];
  item: string;
  /** The main save's number for the item; null when its item list does not know it. */
  itemId: number | null;
  count: number;
  /** Raw money: notes valued by their denomination; null for anything that is not money the bank takes. */
  value: bigint | null;
}
export interface WorldPlayer {
  player: { uuid: string; name: string };
  /** Raw money in notes per place and in all. */
  inventory: bigint;
  enderChest: bigint;
  notes: bigint;
  /** The money stacks. */
  stacks: WorldStack[];
  /** Plain stacks of items that have a market on the main save. */
  valuables: WorldStack[];
}
/** Notes and valuables the region scan found at one place: a block, or an entity's position. */
export interface WorldPlace {
  server: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  /** The block entity's or entity's id: minecraft:chest, banksystem:money_stockpile_block_entity, minecraft:villager. */
  place: string;
  /** offer: a villager's or trader's offers, prices and not notes that exist. */
  source: 'block' | 'entity' | 'offer';
  /** "chest at the overworld, -884 28 -1'024" */
  where: string;
  /** Whose inventory at a bank terminal; null elsewhere. */
  player: { uuid: string; name: string } | null;
  /** The account an upload or download block is bound to; null elsewhere. */
  account: number | null;
  /** Raw money in plain notes. */
  notes: bigint;
  stacks: Omit<WorldStack, 'server' | 'place'>[];
  valuables: Omit<WorldStack, 'server' | 'place'>[];
}
export interface WorldItemsResult {
  /** Why nothing can be counted (no master loaded, no player files); null when the count ran. */
  reason: string | null;
  /** Raw money in notes found, in all and per place; blocks: in blocks and entities, from the region scan. */
  notes: bigint;
  inventory: bigint;
  enderChest: bigint;
  blocks: bigint;
  /** Raw money in notes in villagers' and traders' offers: prices, not notes that exist, so not in notes. */
  offers: bigint;
  /** Places the region scan found notes or valuables at, most notes first; at most 2'000, placesCut says how many more. */
  places: WorldPlace[];
  placesCut: number;
  /** How far the region scan got. */
  scan: ScanStatus;
  /** Players whose files were read and who carry notes or valuables, most notes first. */
  players: WorldPlayer[];
  /** Money items with extra components (renamed, ...): the bank refuses them, so they are not counted. Player files and scan. */
  altered: { stacks: number; count: number };
  /** Players who traded or used the bank but have no readable player file in any loaded save; only those with a name. */
  missing: { uuid: string; name: string }[];
  /** UUIDs that traded or used the bank without a file and without a name anywhere in the save (never joined as a player). */
  unnamed: number;
  /** Players whose only files could not be read (a subset of missing). */
  unreadable: { uuid: string; name: string }[];
  /** Player files read. */
  files: number;
  /** Names of the loaded saves that have no player files (an audit export, a world without playerdata). */
  without: string[];
}

/** The classes of DESIGN_SPEC 8.6. */
export type TransferClass = 'ok' | 'parked' | 'twice' | 'lost' | 'created' | 'known-gap' | 'data-gap' | 'after-snapshot';

/** One item of a transfer, raw amounts. item null: money (every banknote denomination and the base money item, folded into one). */
export interface TransferItem { item: number | null; sent: bigint; received: bigint }

/** One transfer id with the rows of both sides. */
export interface TransferRow {
  id: string;
  /** First and last row of either side. */
  start: number;
  end: number;
  /** From the journal; null when only the master has rows. */
  direction: 'TO_MASTER' | 'FROM_MASTER' | null;
  path: 'ASYNC_BANK' | 'CONVERTER_DEPOSIT' | 'DROP' | null;
  /** The slave whose journal holds it; null when no loaded journal does. */
  server: string | null;
  account: number | null;
  player: { uuid: string; name: string } | null;
  /** The journal's steps, oldest first. */
  steps: string[];
  /**
   * Per item, what left the sending side and what reached the receiving side (DESIGN_SPEC 8.6); the difference of an item is
   * received - sent. Money first, then by item id. Item amounts are item units (count x 100).
   */
  items: TransferItem[];
  /** The master's ledger rows and TRANSFER_PARKED flags with this id. */
  ledger: number[];
  flags: number[];
  class: TransferClass;
  /** Why it is in its class, in one sentence. */
  why: string;
}

export interface TransfersResult {
  transfers: TransferRow[];
  /** Per class, of the transfers in the result. */
  counts: Record<TransferClass, number>;
  /** Why nothing could be checked (no slave with a journal is loaded, ...); null when the check ran. */
  reason: string | null;
}

/**
 * Raw money of notes, for one account of the master's log: proven by its rows. out is net of refunds; net = out - back.
 * An estimate on a save without NoteFlow (2.1.2) when a withdrawal was cut to how far the balance fell (BanknotesResult.putBack).
 */
export interface BanknoteAccount { account: number; owner: { uuid: string; name: string } | null; out: bigint; back: bigint; net: bigint; basis: 'proven' | 'estimate' }
/** Money that appeared on an account between two snapshots without a log row (a positive gap of the check per account). */
export interface BanknoteGap { account: number; owner: { uuid: string; name: string } | null; from: number; to: number; amount: bigint }
/**
 * For one player: out and back from the log rows they made (the player who withdrew or paid in), created and destroyed from
 * the NoteFlow rows that name them. An estimate: notes carry no owner and change hands. net = out - back + created - destroyed.
 */
export interface BanknotePlayer {
  player: { uuid: string; name: string };
  out: bigint;
  back: bigint;
  created: bigint;
  destroyed: bigint;
  net: bigint;
  basis: 'estimate';
}

/**
 * The banknote count (DESIGN_SPEC 8.7): money in notes that should exist outside the bank. Raw money throughout; NoteFlow
 * counts notes, so each of its rows is valued by its denomination. The log is proven, NoteFlow is what the mods recorded.
 */
export interface BanknotesResult {
  /** Why nothing can be counted (no bank data, no money item); null when the count ran. */
  reason: string | null;
  /** Notes that should be outside the bank at the end of the range: every row up to it, not only those in the range. */
  outstanding: bigint;
  /** In the range, from the master's log: handed out (less refunds and put-backs) and paid back in. */
  ledger: { out: bigint; back: bigint };
  /**
   * Save without NoteFlow (2.1.2) only: what its withdrawal rows in the range said beyond how far the balance fell. 2.1.2
   * logged the amount asked for and put notes that did not fit back without a row, so this is taken off out. An estimate.
   */
  putBack: bigint;
  /**
   * Save without NoteFlow (2.1.2) only: money gaps above the check's default threshold ending in the range that no
   * withdrawal row takes up, oldest first, each at most the notes outstanding at its start. They could be notes paid in
   * through the ATM converter (2.1.2 logged none). Not in outstanding. The server filter does not apply.
   */
  appeared: BanknoteGap[];
  /** The other such gaps: more than all notes outside the bank at their start, so an admin action or another cause. */
  tooLarge: BanknoteGap[];
  /** In the range, per NoteFlow source ("banksystem:converter_in", ...; any other source is "other"), sorted by source. */
  flow: { source: string; created: bigint; destroyed: bigint }[];
  /** Accounts with note rows in the range, largest net first. */
  accounts: BanknoteAccount[];
  /** Players named by those rows, largest net first. */
  players: BanknotePlayer[];
  /** The running total over time, from the first row; the range starts with what was outstanding at its start. */
  series: Point[];
  /** Money rows of the log in the range whose direction the save does not give (UNKNOWN_LEGACY, rejected slave codes): not counted. */
  unclear: { rows: number; amount: bigint };
  /** NoteFlow rows in the range of an item that is no money item: not counted. */
  skipped: number;
  /** What the count cannot see or had to estimate, one sentence each: saves without a NoteFlow table, slaves that are not loaded. */
  missing: string[];
}

/**
 * One part of the money flow (DESIGN_SPEC 6.6, 8.10). side in: where money came from; out: where it is now. amount is raw
 * and never negative. A part belongs to one player; the screen adds them up per kind or market.
 * - start (in): the balance at the incident's start (the newest snapshot at or before it, else the first one after it).
 * - market (in): the net trading result on one market, when it is a gain. Proven.
 * - items (out): money kept as goods on a market that lost money: what the goods still held cost at their average buying
 *   price, at most the loss. Proven; items.worth is what they are worth at the usual price before the incident, an estimate.
 * - lost (out): the rest of a losing market's money: lost by buying high and selling low. Proven.
 * - other-server (in or out): trading on servers outside the server filter, netted. Proven.
 * - received, sent: transfers from or to the account `other`. Proven.
 * - notes: notes handed out minus paid back in (DESIGN_SPEC 8.7); out when more went out. An estimate on 2.1.2.
 * - appeared (in, 2.1.2): money that appeared without a log row, at most the notes then outside: probably notes paid in
 *   through the ATM converter. added (in, 2.1.2): more than that: an admin action or another cause. Estimates.
 * - admin: ADMIN_* rows. Proven. removed (out, 2.1.2): money that went without a log row (a negative gap above the
 *   threshold); 2.1.2 logged no admin action. An estimate.
 * - other: every other row (payouts, dividends, raw changes from an unknown source).
 * - unexplained: what the check per account leaves open, below the threshold too; rows whose sign is unknown are in it.
 * - now (out): the balance in the bank's files.
 */
export interface FlowPart {
  kind: 'start' | 'market' | 'items' | 'lost' | 'other-server' | 'received' | 'sent' | 'notes' | 'appeared' | 'added' | 'admin' | 'removed' | 'other' | 'unexplained' | 'now';
  side: 'in' | 'out';
  amount: bigint;
  basis: 'proven' | 'estimate';
  /** Player UUID. */
  player: string;
  /** market, items, lost: the market's item. */
  market: number | null;
  /** received, sent: the other account. */
  other: number | null;
  /** In the incident's markets. */
  incident: boolean;
  /** items: volume kept (raw, x 100) and its worth at the usual price before the incident, an estimate (null: no usual price). */
  items: { qty: bigint; worth: bigint | null } | null;
  /** notes: handed out and paid back in, before netting. */
  notes: { out: bigint; back: bigint } | null;
  accounts: number[];
  /** removed: the two balance snapshots between which the money left (the first one's when merged). */
  gap: { from: number; to: number } | null;
  /** orders: order ids, as orders({ ids }) takes them. findings: the incident's findings about this part. */
  records: { ledger: number[]; orders: number[]; findings: string[] };
}

/**
 * Where the money of an incident's players went (DESIGN_SPEC 6.6, 8.10): per player and personal account, the balance at
 * the incident's start plus every part in equals every part out, the balance now included. Closes by construction:
 * "unexplained" takes the rest. From the incident's start to the copy; the time range does not apply.
 */
export interface MoneyFlow {
  /** Why nothing can be shown; null when it ran. */
  reason: string | null;
  incident: Incident | null;
  /** The incident's players with a personal account, for the switch. */
  players: { uuid: string; name: string }[];
  /** The player asked for, or null: all of them. */
  player: string | null;
  accounts: { account: number; player: string; from: number | null; start: bigint; now: bigint }[];
  parts: FlowPart[];
  /** Where the notes still outside are (estimates), for the chosen players as one: notes out minus notes paid in minus
   *  "appeared" minus others, then in their own files, found elsewhere (any file but the incident players', owner unknown), not found.
   *  With one player chosen, elsewhere and notFound are null: the notes found elsewhere are one pool for all players.
   *  others: notes they took out that a player not chosen likely paid in (a Likely note link, DESIGN_SPEC 8.9). */
  notes: { outside: bigint; inFiles: bigint; elsewhere: bigint | null; notFound: bigint | null; others: { player: { uuid: string; name: string }; amount: bigint }[] };
  /** The copy: when the main save was last played. */
  to: number | null;
  /** The main save is 2.1.2: gaps stand in for what it did not log. */
  legacy: boolean;
  missing: string[];
}

/** How sure a link between two players is (DESIGN_SPEC 8.9). */
export type LinkStrength = 'proven' | 'likely' | 'weak';
/** One way two players are linked; "this" is the player asked about, "they" the other one. */
export type LinkWay =
  /** Proven: both are users of the account (the owner counts as one). The state of the copy: no range applies. */
  | { kind: 'account'; account: number; name: string }
  /** Proven: transfers between an account each of them owns, in the range. sent: from this player's, received: to it. */
  | { kind: 'transfer'; sent: bigint; received: bigint; transfers: number }
  /**
   * Likely: notes one of them withdrew and the other paid in, the exact amount, within a day after. tookOut: this player
   * withdrew. withdrawn: one withdrawal, or a run of them that adds up to the amount, oldest first.
   * paidIn.logged false: money that appeared on a 2.1.2 account without a row, sometime between from and to.
   */
  | { kind: 'notes'; amount: bigint; tookOut: boolean; withdrawn: { account: number; ts: number }[]; paidIn: { account: number; from: number; to: number; logged: boolean } }
  /** Weak: both traded the market in trading sessions that overlap: overlapMs summed over the overlaps. */
  | { kind: 'market'; item: number; overlapMs: number; sessions: number };

export interface PlayerLink {
  player: { uuid: string; name: string };
  strength: LinkStrength;
  /** Proven ways first, then likely, then weak; per weak market the most overlap first. */
  ways: LinkWay[];
  /** orders: order ids, as orders({ ids }) takes them. */
  records: { ledger: number[]; orders: number[] };
}

export interface Overview {
  /** Money on all bank accounts over time (DESIGN_SPEC 8.1): per account the last snapshot at or before each point, summed. */
  money: Point[];
  /** The bank's wealth series (item 32767) summed the same way; null when the save has none (it needs StockMarket). */
  wealth: Point[] | null;
  /** Money on all accounts now, from the bank's files. */
  moneyNow: bigint;
  /** The highest realised profit in the range, at most 5, only players who made a profit. */
  top: PlayerRow[];
  /**
   * Markets whose price in the range went at least twice as far from their usual price, furthest first, at most 4. Each
   * extreme is held against the usual price at its own time; usual is the one at the extreme that went further.
   */
  unusual: { item: number; low: bigint; high: bigint; usual: bigint; times: number; below: boolean }[];
}

/** A moment worth a number on the Overview's chart. */
export type KeyEvent =
  | { kind: 'incident'; time: number; incident: Incident }
  | { kind: 'gap'; time: number; finding: Finding }
  | { kind: 'admin'; time: number; admin: AdminEvent };

/** One admin action (ADMIN_SET, ADMIN_REMOVE, ...) or admin change of BS-257 (RIGHTS_OP, SLAVE_TRUST, ...) from the audit log. */
export interface AdminEvent {
  id: number;
  time: number;
  /** The log's time zone could not be worked out: the time is read in this computer's zone and may be off by whole hours. */
  approximate: boolean;
  type: string;
  account: number | null;
  item: number | null;
  /** Raw, as the ledger row stores it. null for BS-257 changes. */
  amount: bigint | null;
  /** Player name, or the source (ADMIN, CONSOLE, ...) when no player acted. */
  actor: string;
  actorUuid: string | null;
  /** RIGHTS_OP and RIGHTS_DEOP: the player whose rights changed. */
  player: string | null;
  note: string | null;
  /** BS-257 only: what changed, in the mod's words (player, slave, item, company), and its new state (admin, not_admin, trusted, ...). */
  subject: string | null;
  state: string | null;
  /** The ledger row of the action, when the save still has it (the history shows that row already). */
  ledgerId: number | null;
}

export interface EngineApi extends Pick<QueryApi, 'items' | 'players' | 'player' | 'orders' | 'ledger' | 'accounts' | 'account' | 'balances' | 'markets' | 'market' | 'candles' | 'traders' | 'search' | 'sessions' | 'check' | 'findings' | 'incidents' | 'adminEvents' | 'overview' | 'keyEvents' | 'transfers' | 'banknotes' | 'links' | 'moneyFlow' | 'takeBack' | 'worldItems' | 'startScan' | 'stopScan' | 'scanStatus'> {
  /** The saves of the last session, read again only where they changed on disk. */
  workspace(): Workspace;
  addSave(path: string): Workspace;
  removeSave(path: string): Workspace;
  selfCheck(): EngineCheck;
  /** The marks and rule settings of case.json; the defaults when it has none or cannot be read. */
  caseData(): CaseData;
  /** Sets the marks of one finding; a mark with nothing pinned, dismissed or noted is removed. */
  mark(id: string, mark: Mark): CaseData;
  setRules(rules: RuleSettings): CaseData;
  setChoices(choices: CaseChoices): CaseData;
}

/** The same calls as the screens see them: every answer arrives later. */
export type RemoteEngine = { [K in keyof EngineApi]: (...args: Parameters<EngineApi[K]>) => Promise<ReturnType<EngineApi[K]>> };

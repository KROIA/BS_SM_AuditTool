// What the Players screen asks: items, players with their profit, one player in detail, orders and ledger rows.
// Reads the master's cache database. Money and volumes are read as bigint and never pass through a float.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ItemRow, LedgerRow, OrderRow, PlayerAccount, PlayerDetail, PlayerRow, Scope } from '../../shared/api.ts';
import { mainData, mainName } from '../workspace.ts';
import { all, big, names, num, series, text } from './db.ts';
import { profit } from './profit.ts';

/** Inclusive at both ends; null leaves that end open. */
const inTime = (ms: number, s: Scope) => (s.from === null || ms >= s.from) && (s.to === null || ms <= s.to);

const TYPE = ['market', 'limit', 'intermarket'] as const;
/** SM-317 final_status. */
const STATUS = ['filled', 'cancelled by the player', 'cancelled by the server'] as const;

/** Orders up to `to`, oldest first; the time range's start and the server filter are left to the caller. */
export function readOrders(db: DatabaseSync, filter: { player?: string; item?: number; orderId?: number; ids?: number[] }, to: number | null): OrderRow[] {
  const where = ['1'];
  const params: Record<string, SQLInputValue> = {};
  // An order's id is the mod's order_id; old rows have none and go by their row id.
  if (filter.orderId !== undefined) (where.push('(o.order_id = :oid OR (o.order_id IS NULL AND o.id = :oid))'), (params.oid = filter.orderId));
  if (filter.ids !== undefined) (where.push('coalesce(o.order_id, o.id) IN (SELECT value FROM json_each(:ids))'), (params.ids = JSON.stringify(filter.ids)));
  if (filter.player !== undefined) (where.push('o.player = :player'), (params.player = filter.player));
  if (filter.item !== undefined) (where.push('o.item = :item'), (params.item = filter.item));
  if (to !== null) (where.push('o.time <= :to'), (params.to = to));
  const master = mainName();
  return all(db, `SELECT o.*, oo.name AS origin FROM orders o LEFT JOIN order_origin oo ON oo.ref = 'sm:order:' || o.order_id
    WHERE ${where.join(' AND ')} ORDER BY o.time, o.id`, params).map((r) => {
    const amount = big(r.amount)!, price = big(r.price)!;
    const origin = text(r.origin);
    return {
      id: num(r.id)!, orderId: num(r.order_id), item: num(r.item)!, account: num(r.account)!, player: String(r.player),
      type: TYPE[num(r.type)!] ?? 'market', amount, price,
      // OrderHistory keeps the average price (money x 100 / volume, cut off), not the money: this gives it back the same way.
      money: (amount * price) / 100n,
      time: num(r.time)!, finishMs: num(r.finish_time),
      server: origin === null ? null : origin === '' ? master : origin, // an empty origin name is the master
      limitPrice: big(r.limit_price), wanted: big(r.target_volume), status: r.final_status === null ? null : (STATUS[num(r.final_status)!] ?? null),
    };
  });
}
export const counts = (o: OrderRow, s: Scope) => inTime(o.time, s) && (s.server === null || o.server === s.server);
const marketsOf = (list: OrderRow[], s: Scope) => profit(list.map((o) => ({ item: o.item, amount: o.amount, money: o.money, counts: counts(o, s) })));

/** First and last order or ledger row of each player in the scope. Rows without a time are left out. */
function activity(db: DatabaseSync, list: OrderRow[], s: Scope, player?: string) {
  const span = new Map<string, [number, number]>();
  const see = (uuid: string, ms: number) => {
    const old = span.get(uuid);
    span.set(uuid, old ? [Math.min(old[0], ms), Math.max(old[1], ms)] : [ms, ms]);
  };
  for (const o of list) if (o.time > 0 && counts(o, s)) see(o.player, o.time);
  const where = ['actor IS NOT NULL', 'ts > 0'];
  const params: Record<string, SQLInputValue> = {};
  if (player !== undefined) (where.push('actor = :player'), (params.player = player));
  if (s.from !== null) (where.push('ts >= :from'), (params.from = s.from));
  if (s.to !== null) (where.push('ts <= :to'), (params.to = s.to));
  for (const r of all(db, `SELECT actor, min(ts) AS a, max(ts) AS b FROM ledger WHERE ${where.join(' AND ')} ${onServer(s, params)} GROUP BY actor`, params)) {
    see(String(r.actor), num(r.a)!);
    see(String(r.actor), num(r.b)!);
  }
  return span;
}

function summary(uuid: string, name: string, list: OrderRow[], s: Scope, span: Map<string, [number, number]>): PlayerRow & { markets: PlayerDetail['markets'] } {
  const markets = marketsOf(list, s);
  return {
    uuid, name, orders: list.filter((o) => counts(o, s)).length, profit: markets.reduce((sum, m) => sum + m.profit, 0n),
    firstMs: span.get(uuid)?.[0] ?? null, lastMs: span.get(uuid)?.[1] ?? null, markets,
  };
}

export function items(): ItemRow[] {
  const db = mainData();
  if (!db) return [];
  return all(db, 'SELECT id, name, money FROM item ORDER BY id').map((r) => ({ id: num(r.id)!, name: String(r.name), money: r.money === 1n }));
}

export function players(scope: Scope): PlayerRow[] {
  const db = mainData();
  if (!db) return [];
  const nameOf = names(db);
  // ponytail: every order up to the range's end is read for the cost basis; fine for the 10^5 orders of a real save, an aggregate table if it grows past 10^6.
  const byPlayer = new Map<string, OrderRow[]>();
  for (const r of all(db, 'SELECT uuid FROM player')) byPlayer.set(String(r.uuid), []);
  for (const o of readOrders(db, {}, scope.to)) {
    if (!byPlayer.has(o.player)) byPlayer.set(o.player, []);
    byPlayer.get(o.player)!.push(o);
  }
  const span = activity(db, [...byPlayer.values()].flat(), scope);
  return [...byPlayer]
    .map(([uuid, list]) => {
      const { markets: _m, ...row } = summary(uuid, nameOf(uuid), list, scope, span);
      return row;
    })
    .sort((a, b) => (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : a.name.localeCompare(b.name)));
}

export function player(uuid: string, scope: Scope): PlayerDetail | null {
  const db = mainData();
  if (!db) return null;
  const known = all(db, 'SELECT 1 FROM player WHERE uuid = :uuid UNION ALL SELECT 1 FROM orders WHERE player = :uuid LIMIT 1', { uuid }).length > 0;
  if (!known) return null;
  const list = readOrders(db, { player: uuid }, scope.to);
  const row = summary(uuid, names(db)(uuid), list, scope, activity(db, list, scope, uuid));

  const accounts: PlayerAccount[] = all(db, `SELECT a.number, a.name, a.company, a.owner, u.permissions FROM account a
    LEFT JOIN account_user u ON u.account = a.number AND u.uuid = :uuid WHERE a.owner = :uuid OR u.uuid IS NOT NULL
    ORDER BY a.owner IS NOT :uuid, a.number`, { uuid }).map((r) => {
    const owner = r.owner === uuid;
    return { number: num(r.number)!, name: String(r.name), company: text(r.company), owner, permissions: owner ? null : num(r.permissions) };
  });
  const moneyNow = big(all(db, `SELECT coalesce(sum(b.balance + b.locked), 0) AS v FROM balance b JOIN account a ON a.number = b.account
    JOIN item i ON i.id = b.item AND i.money = 1 WHERE a.owner = :uuid`, { uuid })[0]!.v)!;

  // Money over time on the owned accounts, all money items together.
  const params: Record<string, SQLInputValue> = { uuid };
  if (scope.to !== null) params.to = scope.to;
  const money = series(all(db, `SELECT s.account, s.item, s.time, s.balance + s.locked AS v FROM snapshot s JOIN account a ON a.number = s.account
    JOIN item i ON i.id = s.item AND i.money = 1 WHERE a.owner = :uuid ${scope.to !== null ? 'AND s.time <= :to' : ''} ORDER BY s.time, s.id`, params), scope);

  const buys = list.filter((o) => counts(o, scope) && o.amount > 0n).length;
  return { ...row, accounts, moneyNow, buys, money };
}

export function orders(filter: { player?: string; item?: number; ids?: number[]; limit?: number }, scope: Scope): OrderRow[] {
  const db = mainData();
  if (!db) return [];
  return readOrders(db, filter, scope.to).filter((o) => counts(o, scope)).reverse().slice(0, filter.limit);
}

// ---- The bank's log ----

/** Kinds whose amount is stored with its sign (RAW_CHANGE and the EXTERNAL pair are BS-254, LedgerType.java:13-15). */
const SIGNED = new Set(['TRANSFER', 'SHARE_TRADE', 'RAW_CHANGE', 'EXTERNAL_BIND', 'EXTERNAL_UNBIND']);
const OUT = new Set(['WITHDRAW', 'ADMIN_REMOVE', 'BANK_CLOSED', 'CONVERTER_WITHDRAW', 'DOWNLOAD_WITHDRAW', 'CRAFT_CONSUME',
  'ACCOUNT_DELETE_PAYOUT', 'ADMIN_DISALLOW_ITEM', 'ACCOUNT_DELETE_LOSS', 'TRANSFER_OUT']);
const IN = new Set(['DEPOSIT', 'WITHDRAW_REFUND', 'ADMIN_ADD', 'CONVERTER_DEPOSIT', 'UPLOAD_DEPOSIT', 'CRAFT_OUTPUT', 'STARTING_BALANCE', 'TRANSFER_IN']);
/**
 * No change to free plus locked: an unlock moves locked money to free, an edit and a freeze change no balance, and the
 * share rows only count a company's issued shares (item 0, amount 1 share; ShareStamperBlockEntity.java:302-319).
 * REFUND_LOST (BS-267) only marks notes whose refund could not be booked back: the WITHDRAW row already took the money.
 */
const NONE = new Set(['ADMIN_UNLOCK', 'ADMIN_ACCOUNT_EDIT', 'ACCOUNT_FREEZE', 'SHARE_STAMP', 'SHARE_REDEEM', 'REFUND_LOST']);

/** What a row did to its balance; null when the save does not say. TRANSFER_IN and _OUT are the kinds of 2.1.2. */
export function change(kind: string, amount: bigint, note: string | null, balanceAfter: bigint | null): bigint | null {
  const abs = amount < 0n ? -amount : amount;
  if (kind === 'TRADE_BUY') return abs;
  if (kind === 'TRADE_SELL') return -abs;
  if (SIGNED.has(kind)) return amount;
  if (kind === 'PAYOUT' || kind === 'DIVIDEND') return balanceAfter === null ? null : amount; // signed per leg only since balance_after
  if (kind === 'ADMIN_SET') {
    const m = /(-?\d+)->(-?\d+)\s*$/.exec(note ?? ''); // "old->new", sometimes after a prefix: "money set <name>: old->new"
    return m ? BigInt(m[2]!) - BigInt(m[1]!) : null;
  }
  if (OUT.has(kind)) return -abs;
  if (IN.has(kind)) return abs;
  if (NONE.has(kind)) return 0n;
  return null; // UNKNOWN_LEGACY and kinds this version of the tool does not know
}

/**
 * The SQL condition of the server filter on ledger rows (BS-256): a row made on the filtered server, and every row of a log
 * without an origin column (server NULL). '' is the master. Sets :server in params.
 */
export function onServer(scope: Scope, params: Record<string, SQLInputValue>, column = 'server'): string {
  if (scope.server === null) return '';
  params.server = scope.server === mainName() ? '' : scope.server;
  return `AND (${column} IS NULL OR ${column} = :server)`;
}

export function ledger(filter: { accounts?: number[]; ids?: number[] }, scope: Scope): LedgerRow[] {
  const db = mainData();
  const [column, list] = filter.ids ? ['id', filter.ids] : ['account', filter.accounts ?? []];
  if (!db || list.length === 0) return [];
  const nameOf = names(db), master = mainName();
  const params: Record<string, SQLInputValue> = { list: JSON.stringify(list) };
  if (scope.from !== null) params.from = scope.from;
  if (scope.to !== null) params.to = scope.to;
  return all(db, `SELECT * FROM ledger WHERE ${column} IN (SELECT value FROM json_each(:list))
    ${scope.from !== null ? 'AND ts >= :from' : ''} ${scope.to !== null ? 'AND ts <= :to' : ''} ${onServer(scope, params)} ORDER BY ts DESC, id DESC`, params).map((r) => {
    const server = text(r.server), dimension = text(r.dimension);
    const kind = String(r.kind), amount = big(r.amount)!, note = text(r.note), balanceAfter = big(r.balance_after);
    const actor = text(r.actor);
    // Trade rows (OrderLedger.logDelta): amount is the goods, money_amount the money, both stored without a sign. A buy pays money.
    const trade = (kind === 'TRADE_BUY' || kind === 'TRADE_SELL') && r.money_amount !== null && r.currency_item !== null;
    const paid = trade ? big(r.money_amount)! : 0n;
    return {
      id: num(r.id)!, time: num(r.ts)!, account: num(r.account)!, kind, item: num(r.item)!, amount,
      change: change(kind, amount, note, balanceAfter),
      money: trade ? { item: num(r.currency_item)!, change: kind === 'TRADE_BUY' ? -paid : paid } : null,
      actor, actorName: actor ? nameOf(actor, text(r.actor_name)) : text(r.actor_name), sourceKind: text(r.source_kind), otherAccount: num(r.other_account),
      balanceAfter, ref: text(r.ref), note,
      server: server === '' ? master : server,
      place: dimension === null || r.x === null || r.y === null || r.z === null ? null : { dimension, x: num(r.x)!, y: num(r.y)!, z: num(r.z)! },
    };
  });
}

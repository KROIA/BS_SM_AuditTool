// What the Markets screen asks: the markets with their swing, one market's facts, its candles and who traded there.
// Candles cover months at one per minute, so long ranges read the 1-hour table and only the minutes at the range's edges.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Candle, MarketFacts, MarketRow, OrderRow, Scope, Trader } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { all, big, names, num, type Row } from './db.ts';
import { profit } from './profit.ts';
import { counts, readOrders } from './players.ts';

const H = 3_600_000;
const CAP = 5000;
const COLS = 'market, time, open, low, high, volume';

/**
 * The candles of the scope as one SQL source with the columns of COLS: whole hours from candle_hour, the minutes
 * before the first and after the last whole hour from candle. market null: every market.
 */
export function source(s: Scope, market: number | null) {
  const params: Record<string, SQLInputValue> = {};
  if (market !== null) params.m = market;
  const hf = s.from === null ? null : Math.ceil(s.from / H) * H;
  const ht = s.to === null ? null : Math.floor((s.to + 1) / H) * H; // hours that end inside the scope start before this
  const minutes: [number, number][] = [];
  const parts: string[] = [];
  if (hf !== null && ht !== null && hf >= ht) minutes.push([s.from!, s.to!]);
  else {
    const where = ['1'];
    if (market !== null) where.push('market = :m');
    if (hf !== null) (where.push('time >= :hf'), (params.hf = hf));
    if (ht !== null) (where.push('time < :ht'), (params.ht = ht));
    parts.push(`SELECT ${COLS} FROM candle_hour WHERE ${where.join(' AND ')}`);
    if (hf !== null && s.from! < hf) minutes.push([s.from!, hf - 1]);
    if (ht !== null && ht <= s.to!) minutes.push([ht, s.to!]);
  }
  minutes.forEach(([a, b], i) => {
    params[`a${i}`] = a;
    params[`b${i}`] = b;
    parts.push(market !== null
      ? `SELECT ${COLS} FROM candle WHERE market = :m AND time BETWEEN :a${i} AND :b${i}`
      // Through the (market, time) index once per market, not a scan of every candle.
      : `SELECT c.market, c.time, c.open, c.low, c.high, c.volume FROM (SELECT DISTINCT market FROM candle_hour) k
         JOIN candle c ON c.market = k.market AND c.time BETWEEN :a${i} AND :b${i}`);
  });
  return { sql: parts.join(' UNION ALL '), params };
}

/** The 1-minute candles of one market in the scope: the WHERE clause and its parameters. */
function minuteWhere(item: number, s: Scope) {
  const params: Record<string, SQLInputValue> = { m: item };
  if (s.from !== null) params.from = s.from;
  if (s.to !== null) params.to = s.to;
  return { where: `market = :m ${s.from !== null ? 'AND time >= :from' : ''} ${s.to !== null ? 'AND time <= :to' : ''}`, params };
}

/** The median: the middle value, or the two middle values averaged and cut off. */
const middle = (a: bigint, b: bigint | undefined) => (b === undefined ? a : (a + b) / 2n);

export function markets(scope: Scope): MarketRow[] {
  const db = mainData();
  if (!db) return [];
  const rows = new Map<number, MarketRow>();
  const row = (item: number) => rows.get(item) ?? rows.set(item, { item, price: null, swing: null, low: null, high: null, orders: 0 }).get(item)!;
  for (const r of all(db, 'SELECT DISTINCT market FROM candle_hour')) row(num(r.market)!);
  for (const r of all(db, 'SELECT item, price FROM market')) row(num(r.item)!).price = big(r.price);
  for (const o of readOrders(db, {}, scope.to)) if (counts(o, scope)) row(o.item).orders++;
  const src = source(scope, null);
  for (const r of all(db, `SELECT market, max(high) AS hi, min(low) AS lo FROM (${src.sql}) GROUP BY market`, src.params)) {
    const lo = big(r.lo)!, m = row(num(r.market)!);
    [m.low, m.high] = [lo, big(r.hi)!];
    m.swing = Number(m.high) / Number(lo > 0n ? lo : 1n); // ponytail: a low of 0 counts as 1 raw (0.01)
  }
  // Under an incident's focus only the markets its players traded on.
  return [...rows.values()].filter((m) => !scope.focus || m.orders > 0).sort((a, b) => (b.swing ?? -1) - (a.swing ?? -1) || b.orders - a.orders || a.item - b.item);
}

/** The usual price: the median open of the 1-minute candles in the scope, else the median price of the orders given. */
function usual(db: DatabaseSync, item: number, scope: Scope, list: OrderRow[]): bigint | null {
  const m = minuteWhere(item, scope);
  const n = Number(all(db, `SELECT count(*) AS n FROM candle WHERE ${m.where}`, m.params)[0]!.n);
  if (n > 0) {
    const mid = all(db, `SELECT open FROM candle WHERE ${m.where} ORDER BY open LIMIT :k OFFSET :o`, { ...m.params, k: BigInt(2 - (n % 2)), o: BigInt((n - 1) >> 1) });
    return middle(big(mid[0]!.open)!, mid[1] ? big(mid[1].open)! : undefined);
  }
  return median(list.map((o) => o.price));
}

/** The median of whole numbers; null for none. */
export function median(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const p = BigInt64Array.from(values).sort();
  return middle(p[(p.length - 1) >> 1]!, p.length % 2 ? undefined : p[p.length >> 1]);
}

const usualCache = new WeakMap<DatabaseSync, Map<number, bigint | null>>();
/** The usual price over all loaded data: what usualAt falls back to. Worked out once per market while the same saves stay loaded. */
export function usualPrice(item: number): bigint | null {
  const db = mainData();
  if (!db) return null;
  const known = usualCache.get(db) ?? usualCache.set(db, new Map()).get(db)!;
  if (!known.has(item)) known.set(item, usual(db, item, { from: null, to: null, server: null }, readOrders(db, { item }, null)));
  return known.get(item)!;
}

const DAY = 1440, FEW = 60;
const atCache = new WeakMap<DatabaseSync, Map<string, bigint | null>>();
/**
 * The usual price of a market at a moment (AT-45): the median open of the last 1'440 one-minute candles
 * before the moment's hour, so it follows the market. Fewer than 60 candles before it: usualPrice (all data). Cached per
 * market and hour (null: too few candles); each hour is one read of at most 1'440 rows from the candle index (market, time, open).
 */
export function usualAt(item: number, ms: number): bigint | null {
  const db = mainData();
  if (!db) return null;
  return windowed(db, item, ms) ?? usualPrice(item);
}
function windowed(db: DatabaseSync, item: number, ms: number): bigint | null {
  const hour = Math.floor(ms / H) * H, key = `${item}:${hour}`;
  const known = atCache.get(db) ?? atCache.set(db, new Map()).get(db)!;
  if (!known.has(key)) {
    const opens = all(db, 'SELECT open FROM candle WHERE market = :m AND time < :t ORDER BY time DESC LIMIT :k', { m: item, t: hour, k: BigInt(DAY) }).map((r) => big(r.open)!);
    known.set(key, opens.length < FEW ? null : median(opens));
  }
  return known.get(key)!;
}

/**
 * The chart's usual line: the windowed usual price for many moments of one market, oldest first, null where fewer than 60
 * candles lie before (no all-data fallback, which would draw a false drop at the left edge). Close hours not known yet are
 * worked out from one ordered read of the minutes they need, not one read per hour: the 2'400 hours of a real market took
 * 1.4 s one by one.
 */
function usualSeries(db: DatabaseSync, item: number, times: number[]): (bigint | null)[] {
  const known = atCache.get(db) ?? atCache.set(db, new Map()).get(db)!;
  const hours = [...new Set(times.map((t) => Math.floor(t / H) * H))].filter((h) => !known.has(`${item}:${h}`));
  // One read covers every minute between the hours; one read per hour covers 1'440 each: take the smaller.
  if (hours.length > 1 && hours.length * DAY > (hours.at(-1)! - hours[0]!) / 60_000) {
    const first = num(all(db, 'SELECT min(time) AS t FROM (SELECT time FROM candle WHERE market = :m AND time < :h ORDER BY time DESC LIMIT :k)', { m: item, h: hours[0]!, k: BigInt(DAY) })[0]!.t);
    const rows = all(db, 'SELECT time, open FROM candle WHERE market = :m AND time >= :a AND time < :b ORDER BY time', { m: item, a: first ?? hours[0]!, b: hours.at(-1)! });
    const time = rows.map((r) => num(r.time)!), open = rows.map((r) => big(r.open)!);
    let i = 0;
    for (const h of hours) {
      while (i < time.length && time[i]! < h) i++;
      const opens = open.slice(Math.max(0, i - DAY), i);
      known.set(`${item}:${h}`, opens.length < FEW ? null : median(opens));
    }
  }
  return times.map((t) => windowed(db, item, t));
}
/** usualAt for "now": every candle there is lies before it. */
const END = 8.64e15;

export function market(item: number, scope: Scope): MarketFacts {
  const db = mainData();
  if (!db) return { usual: null, low: null, high: null, volume: 0, traders: 0 };
  const src = source(scope, item);
  const f = all(db, `SELECT min(low) AS lo, max(high) AS hi, total(volume) AS v FROM (${src.sql})`, src.params)[0]!;
  const list = readOrders(db, { item }, scope.to).filter((o) => counts(o, scope));
  // The usual price at the end of the range (AT-45). scope.to is the last millisecond in it, so its own hour counts.
  return { usual: usualAt(item, scope.to === null ? END : scope.to + 1), low: big(f.lo), high: big(f.hi), volume: Number(f.v), traders: new Set(list.map((o) => o.player)).size };
}

/**
 * The newest CAP candles of the scope up to end (the whole scope without it). span: the time all candles of the scope
 * cover, so a chart can ask for an older or newer part with another end; capped: span holds more than came back.
 */
export function candles(item: number, minutes: 1 | 5 | 15 | 60 | 1440, scope: Scope, end?: number):
{ candles: Candle[]; capped: boolean; usual: (bigint | null)[]; span: { from: number; to: number } | null } {
  const db = mainData();
  if (!db) return { candles: [], capped: false, usual: [], span: null };
  const query = (s: Scope) => (minutes >= 60 ? source(s, item) : (({ where, params }) => ({ sql: `SELECT ${COLS} FROM candle WHERE ${where}`, params }))(minuteWhere(item, s)));
  const cut = end !== undefined && (scope.to === null || end < scope.to);
  const q = query(cut ? { ...scope, to: end } : scope);
  const st = db.prepare(`${q.sql} ORDER BY time DESC`);
  st.setReadBigInts(true);
  const iv = minutes * 60_000;
  const out: Candle[] = []; // newest first while reading
  let capped = cut;
  for (const r of st.iterate(q.params) as Iterable<Row>) {
    const time = Math.floor(num(r.time)! / iv) * iv, open = big(r.open)!, low = big(r.low)!, high = big(r.high)!;
    const last = out.at(-1);
    if (last?.time === time) {
      last.open = open; // rows come newest first: this one is earlier in the candle
      if (high > last.high) last.high = high;
      if (low < last.low) last.low = low;
      last.volume += Number(r.volume);
      continue;
    }
    if (out.length === CAP) {
      capped = true;
      break;
    }
    out.push({ time, open, high, low, close: null, volume: Number(r.volume) });
  }
  out.reverse();
  // The mods store no close: it is the next candle's open. The newest one closes at the open of the next candle after
  // it, also when that lies past the scope.
  for (let i = 0; i + 1 < out.length; i++) out[i]!.close = out[i + 1]!.open;
  const last = out.at(-1);
  if (!last) return { candles: [], capped: false, usual: [], span: null };
  const next = all(db, 'SELECT open FROM candle WHERE market = :m AND time >= :t ORDER BY time LIMIT 1', { m: item, t: last.time + iv })[0];
  last.close = next ? big(next.open) : null;
  let span = { from: out[0]!.time, to: last.time + iv };
  if (capped) {
    const whole = query(scope), edge = (dir: string) => num(all(db, `SELECT time FROM (${whole.sql}) ORDER BY time ${dir} LIMIT 1`, whole.params)[0]!.time)!;
    span = { from: Math.floor(edge('ASC') / iv) * iv, to: Math.floor(edge('DESC') / iv) * iv + iv };
  }
  // The usual price that follows the market (AT-45): one per candle, worked out once per hour.
  return { candles: out, capped, usual: usualSeries(db, item, out.map((c) => c.time)), span };
}

export function traders(item: number, scope: Scope): Trader[] {
  const db = mainData();
  if (!db) return [];
  const nameOf = names(db);
  const byPlayer = new Map<string, ReturnType<typeof readOrders>>();
  for (const o of readOrders(db, { item }, scope.to)) {
    if (!byPlayer.has(o.player)) byPlayer.set(o.player, []);
    byPlayer.get(o.player)!.push(o);
  }
  const out: Trader[] = [];
  for (const [uuid, list] of byPlayer) {
    const m = profit(list.map((o) => ({ item, amount: o.amount, money: o.money, counts: counts(o, scope) })))[0];
    if (m) out.push({ uuid, name: nameOf(uuid), bought: m.bought, sold: m.sold, profit: m.profit });
  }
  return out.sort((a, b) => (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : a.name.localeCompare(b.name)));
}

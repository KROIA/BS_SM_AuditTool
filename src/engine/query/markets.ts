// What the Markets screen asks: the markets with their swing, one market's facts, its candles and who traded there.
// Candles cover months at one per minute, so long ranges read the 1-hour table and only the minutes at the range's edges.
import type { SQLInputValue } from 'node:sqlite';
import type { Candle, MarketFacts, MarketRow, Scope, Trader } from '../../shared/api.ts';
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
function source(s: Scope, market: number | null) {
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

/** DESIGN_SPEC 8.1 median: the middle value, or the two middle values averaged and cut off. */
const middle = (a: bigint, b: bigint | undefined) => (b === undefined ? a : (a + b) / 2n);

export function markets(scope: Scope): MarketRow[] {
  const db = mainData();
  if (!db) return [];
  const rows = new Map<number, MarketRow>();
  const row = (item: number) => rows.get(item) ?? rows.set(item, { item, price: null, swing: null, orders: 0 }).get(item)!;
  for (const r of all(db, 'SELECT DISTINCT market FROM candle_hour')) row(num(r.market)!);
  for (const r of all(db, 'SELECT item, price FROM market')) row(num(r.item)!).price = big(r.price);
  for (const o of readOrders(db, {}, scope.to)) if (counts(o, scope)) row(o.item).orders++;
  const src = source(scope, null);
  for (const r of all(db, `SELECT market, max(high) AS hi, min(low) AS lo FROM (${src.sql}) GROUP BY market`, src.params)) {
    const lo = big(r.lo)!;
    row(num(r.market)!).swing = Number(big(r.hi)!) / Number(lo > 0n ? lo : 1n); // ponytail: a low of 0 counts as 1 raw (0.01)
  }
  return [...rows.values()].sort((a, b) => (b.swing ?? -1) - (a.swing ?? -1) || b.orders - a.orders || a.item - b.item);
}

export function market(item: number, scope: Scope): MarketFacts {
  const db = mainData();
  if (!db) return { usual: null, low: null, high: null, volume: 0, traders: 0 };
  const src = source(scope, item);
  const f = all(db, `SELECT min(low) AS lo, max(high) AS hi, total(volume) AS v FROM (${src.sql})`, src.params)[0]!;
  const list = readOrders(db, { item }, scope.to).filter((o) => counts(o, scope));

  const m = minuteWhere(item, scope);
  const n = Number(all(db, `SELECT count(*) AS n FROM candle WHERE ${m.where}`, m.params)[0]!.n);
  let usual: bigint | null = null;
  if (n > 0) {
    const mid = all(db, `SELECT open FROM candle WHERE ${m.where} ORDER BY open LIMIT :k OFFSET :o`, { ...m.params, k: BigInt(2 - (n % 2)), o: BigInt((n - 1) >> 1) });
    usual = middle(big(mid[0]!.open)!, mid[1] ? big(mid[1].open)! : undefined);
  } else if (list.length > 0) {
    const p = list.map((o) => o.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    usual = middle(p[(p.length - 1) >> 1]!, p.length % 2 ? undefined : p[p.length >> 1]);
  }
  return { usual, low: big(f.lo), high: big(f.hi), volume: Number(f.v), traders: new Set(list.map((o) => o.player)).size };
}

export function candles(item: number, minutes: 1 | 5 | 15 | 60 | 1440, scope: Scope): { candles: Candle[]; capped: boolean } {
  const db = mainData();
  if (!db) return { candles: [], capped: false };
  const q = minutes >= 60 ? source(scope, item) : (({ where, params }) => ({ sql: `SELECT ${COLS} FROM candle WHERE ${where}`, params }))(minuteWhere(item, scope));
  const st = db.prepare(`${q.sql} ORDER BY time`);
  st.setReadBigInts(true);
  const iv = minutes * 60_000;
  const out: Candle[] = [];
  let capped = false;
  for (const r of st.iterate(q.params) as Iterable<Row>) {
    const time = Math.floor(num(r.time)! / iv) * iv, open = big(r.open)!, low = big(r.low)!, high = big(r.high)!;
    const last = out.at(-1);
    if (last?.time === time) {
      if (high > last.high) last.high = high;
      if (low < last.low) last.low = low;
      last.volume += Number(r.volume);
      continue;
    }
    if (last) last.close = open; // the mods store no close: it is the next candle's open
    if (out.length === CAP) {
      capped = true;
      break;
    }
    out.push({ time, open, high, low, close: null, volume: Number(r.volume) });
  }
  const last = out.at(-1);
  if (last && !capped) {
    // The newest candle of the scope closes at the open of the next one after it, also when that lies past the scope.
    const next = all(db, 'SELECT open FROM candle WHERE market = :m AND time >= :t ORDER BY time LIMIT 1', { m: item, t: last.time + iv })[0];
    last.close = next ? big(next.open) : null;
  }
  return { candles: out, capped };
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

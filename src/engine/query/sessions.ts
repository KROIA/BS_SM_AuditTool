// Realised profit by sale, trading sessions and profit per clock hour: the building blocks of the rules.
import type { OrderRow, Scope, Session } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { median } from './markets.ts';
import { counts, readOrders } from './players.ts';
import { profit } from './profit.ts';

/** Orders less than this apart (time placed) belong to one session; this far apart or more, a new one starts. */
const GAP = 5 * 60_000;
const HOUR = 3_600_000;

export interface Sale {
  order: OrderRow;
  profit: bigint;
  /** The part of the sale the player had not bought on the market: never profit. */
  withoutPurchase: bigint;
}

/** Each sale of one player's orders (oldest first) with its realised profit; the average cost carries over from every earlier trade. */
export function sales(list: OrderRow[]): Sale[] {
  const out: Sale[] = [];
  profit(list.map((o) => ({ item: o.item, amount: o.amount, money: o.money, counts: false })), (i, p, w) => out.push({ order: list[i]!, profit: p, withoutPurchase: w }));
  return out;
}

function summary(list: OrderRow[], sale: Map<OrderRow, Sale>): Session {
  const own = list.flatMap((o) => sale.get(o) ?? []);
  const gap = median(list.slice(1).map((o, i) => BigInt(o.time - list[i]!.time)));
  return {
    start: list[0]!.time, end: list.at(-1)!.time, orders: list.length, markets: [...new Set(list.map((o) => o.item))],
    profit: own.reduce((s, x) => s + x.profit, 0n), soldWithoutPurchase: own.reduce((s, x) => s + x.withoutPurchase, 0n),
    medianGapMs: gap === null ? null : Number(gap),
  };
}

/** One player's orders (oldest first) cut into sessions. Only the orders on `server` form sessions (null: all); profit uses every order. */
export function split(list: OrderRow[], server: string | null): Session[] {
  const sale = new Map(sales(list).map((s) => [s.order, s]));
  const out: Session[] = [];
  let run: OrderRow[] = [];
  for (const o of list) {
    if (server !== null && o.server !== server) continue;
    if (run.length && o.time - run.at(-1)!.time >= GAP) (out.push(summary(run, sale)), (run = []));
    run.push(o);
  }
  if (run.length) out.push(summary(run, sale));
  return out;
}

/** One player's sessions that overlap the time range, whole, oldest first. */
export function sessions(uuid: string, scope: Scope): Session[] {
  const db = mainData();
  if (!db) return [];
  return split(readOrders(db, { player: uuid }, null), scope.server)
    .filter((s) => (scope.from === null || s.end >= scope.from) && (scope.to === null || s.start <= scope.to));
}

/**
 * Realised profit of one player's orders (oldest first) per clock hour of the sale (time placed): start of the hour -> profit.
 * Only hours with a sale in the scope. Hours are UTC; they are the same hours in nearly every time zone, which are whole hours away from UTC.
 */
export function hours(list: OrderRow[], scope: Scope): Map<number, bigint> {
  const out = new Map<number, bigint>();
  for (const s of sales(list)) {
    if (!counts(s.order, scope)) continue;
    const hour = Math.floor(s.order.time / HOUR) * HOUR;
    out.set(hour, (out.get(hour) ?? 0n) + s.profit);
  }
  return out;
}

/** hours() of every player, for the rule "Profit per hour". */
export function hourlyProfit(scope: Scope): { player: string; hour: number; profit: bigint }[] {
  const db = mainData();
  if (!db) return [];
  const byPlayer = new Map<string, OrderRow[]>();
  for (const o of readOrders(db, {}, scope.to)) byPlayer.get(o.player)?.push(o) ?? byPlayer.set(o.player, [o]);
  return [...byPlayer].flatMap(([player, list]) => [...hours(list, scope)].map(([hour, profit]) => ({ player, hour, profit })));
}

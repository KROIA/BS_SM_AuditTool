// Realised profit per item with the average cost method (DESIGN_SPEC 8.1). Pure: orders in, figures out.
import type { MarketProfit } from '../../shared/api.ts';

export interface Trade {
  item: number;
  /** Raw volume, + bought, - sold. */
  amount: bigint;
  /** Raw money of the order, signed like amount (OrderRow.money). */
  money: bigint;
  /** Inside the scope: counts for the figures. Orders outside it still move the holding and its cost. */
  counts: boolean;
}

/**
 * trades must be in the order they happened. A sale takes its cost from the average cost of what the player holds;
 * the part of a sale beyond the holding was never bought on the market and is soldWithoutPurchase, not profit.
 * Whole-number division cuts towards zero at each step, so the figures are exact and repeatable, not rounded.
 */
export function profit(trades: Trade[]): MarketProfit[] {
  const byItem = new Map<number, MarketProfit & { qty: bigint; cost: bigint }>();
  for (const t of trades) {
    let m = byItem.get(t.item);
    if (!m) byItem.set(t.item, (m = { item: t.item, orders: 0, bought: 0n, sold: 0n, profit: 0n, soldWithoutPurchase: 0n, qty: 0n, cost: 0n }));
    if (t.counts) m.orders++;
    if (t.amount > 0n) {
      m.qty += t.amount;
      m.cost += t.money;
      if (t.counts) m.bought += t.money;
    } else if (t.amount < 0n) {
      const volume = -t.amount, got = -t.money;
      const covered = volume < m.qty ? volume : m.qty;
      const cost = m.qty > 0n ? (m.cost * covered) / m.qty : 0n;
      const coveredMoney = (got * covered) / volume;
      m.qty -= covered;
      m.cost -= cost;
      if (t.counts) {
        m.sold += got;
        m.profit += coveredMoney - cost;
        m.soldWithoutPurchase += got - coveredMoney;
      }
    }
  }
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return [...byItem.values()]
    .filter((m) => m.orders > 0)
    .map(({ qty: _q, cost: _c, ...m }) => m)
    .sort((a, b) => (abs(b.profit) > abs(a.profit) ? 1 : abs(b.profit) < abs(a.profit) ? -1 : b.orders - a.orders));
}

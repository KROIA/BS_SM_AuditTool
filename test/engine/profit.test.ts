import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profit, type Trade } from '../../src/engine/query/profit.ts';

const t = (amount: bigint, money: bigint, counts = true, item = 2): Trade => ({ item, amount, money, counts });

test('average cost: buys at two prices, a partial sale, then a sale beyond the holding', () => {
  // Buy 10 items for $100, then 30 for $600: 40 items cost $700, $17.50 each on average.
  // Sell 20 for $800: cost 20 x 17.50 = $350, profit $450. 20 items left, cost $350.
  // Sell 30 for $900: 20 are covered (cost $350, money 900 x 20/30 = $600, profit $250); the other 10 were never bought: $300.
  const out = profit([t(1000n, 10000n), t(3000n, 60000n), t(-2000n, -80000n), t(-3000n, -90000n)]);
  assert.deepEqual(out, [{ item: 2, orders: 4, bought: 70000n, sold: 170000n, profit: 70000n, soldWithoutPurchase: 30000n }]);
});

test('purchases before the range set the cost; only sales inside it count', () => {
  // Bought before the range: 3 items for $10.00 (cost per item 3.333...). Selling 1 for $5.00 costs 1000 x 1/3 = 333 raw, cut off.
  const out = profit([t(300n, 1000n, false), t(-100n, -500n), t(-100n, -500n, false)]);
  assert.deepEqual(out, [{ item: 2, orders: 1, bought: 0n, sold: 500n, profit: 167n, soldWithoutPurchase: 0n }]);
});

test('markets without an order in the range are left out; the largest profit or loss comes first', () => {
  const out = profit([t(100n, 100n, false, 3), t(100n, 1000n, true, 4), t(-100n, -500n, true, 4), t(100n, 100n, true, 5), t(-100n, -200n, true, 5)]);
  assert.deepEqual(out.map((m) => [m.item, m.profit]), [[4, -500n], [5, 100n]]);
});

// The rules over all loaded data. Each rule's findings are kept per workspace (the cache database)
// and its own settings: the same settings give them back at once, a changed threshold re-runs only that rule.
//
// Facts per rule (keys of Finding.facts; money and volumes raw):
//   round-trip   bought, buyPrice, sold, sellPrice, seconds, profit (of the most extreme round), rounds
//   order-rate   busiestSecond, orders, medianGapMs
//   hour-profit  hour, profit (the best hour), others (all other players that hour), hours, total
//   far-price    price, usual (of the most extreme order), orders
//   price-spike  time, low, high (of the most extreme candle), usual, minutes
//   balance      item, difference (signed), labels, rating
//   order-ledger volume, logged (of the order furthest off), orders
//   bank-flag    flagType, severity, amount, ref, details; origin 'audit log' and approximateTime for a flag only the audit log has
//   last-save    lastSave, rows
//   market-alert kind (profit, pump_dump_pump, pump_dump_cycle, other), amount (raw), windowMs, threshold (as stored: real money
//                or percent), text; for a pump open (the minute's candle open, null without one), percent (null without a candle)
//   transfer     transferId, class (lost, twice, created, parked), direction, path, item (null: money), sent, received (of that
//                item), itemsOff (items that differ), steps, why
//   banknotes    outstanding (the note count, corrected on 2.1.2), found (in player files and the region scan), difference
//                (found - outstanding), inventory, enderChest, blocks (in blocks and entities), offers (in villagers' offers, not in
//                found), putBack, appeared (money that could be notes paid back through the converter, 2.1.2), missing and
//                unreadable (names of players without a readable file), unnamed (how many UUIDs without a file or a name),
//                without (saves), scan (the coverage's state), scanFiles, scanFilesTotal, chunksUnread, lz4, filesUnread
import type { DatabaseSync } from 'node:sqlite';
import type { Fact, Finding, FindingsResult, Level, OrderRow, RuleId, RuleSettings, RuleStatus, Scope, TransferItem } from '../../shared/api.ts';
import { mainData, mainSave } from '../workspace.ts';
import { allGaps, moneyItems, threshold } from './check.ts';
import { all, big, names, num, text } from './db.ts';
import { median, usualAt } from './markets.ts';
import { readOrders } from './players.ts';
import { sales } from './sessions.ts';
import { allTransfers, noTransfers } from './transfers.ts';
import { worldItems } from './world.ts';
import { banknotes } from './banknotes.ts';
import { scanStamp } from '../scan.ts';

const MIN = 60_000, HOUR = 3_600_000;
/** Hits of one rule on the same subject less than this apart form one finding. */
const REPEAT = 15 * MIN;
const UP: Record<Level, Level> = { low: 'medium', medium: 'high', high: 'critical', critical: 'critical' };
export const RANK: Record<Level, number> ={ critical: 0, high: 1, medium: 2, low: 3 };
const abs = (v: bigint) => (v < 0n ? -v : v);
const ratio = (a: bigint, b: bigint) => Number(a) / Number(b > 0n ? b : 1n); // ponytail: a price of 0 counts as 1 raw, like the markets' swing

/** The rule's level, one higher at ten times the threshold or more. */
export function level(base: Level, value: number | bigint, limit: number | bigint | null): Level {
  if (limit === null) return base;
  const ten = typeof value === 'bigint' ? value >= BigInt(limit) * 10n : value >= Number(limit) * 10;
  return ten ? UP[base] : base;
}

/** What one rule saw once. subject: the player or market that repeated hits share. */
interface Hit { subject: string; start: number; end: number; value: number | bigint; orders: OrderRow[]; facts: Record<string, Fact> }

/** Hits of one subject less than 15 minutes apart (end of the group to start of the next hit), each group oldest first. */
export function group<H extends Hit>(hits: H[]): H[][] {
  hits.sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.start - b.start));
  const out: H[][] = [];
  let end = 0;
  for (const h of hits) {
    const g = out.at(-1);
    if (g && g[0]!.subject === h.subject && h.start - end < REPEAT) {
      g.push(h);
      end = Math.max(end, h.end);
    } else {
      out.push([h]);
      end = h.end;
    }
  }
  return out;
}

const blank = (rule: RuleId, key: string): Pick<Finding, 'id' | 'rule' | 'basis' | 'source' | 'players' | 'markets' | 'accounts' | 'servers' | 'records' | 'acknowledged'> => ({
  id: `${rule}:${key}`, rule, basis: 'proven', source: 'tool', players: [], markets: [], accounts: [], servers: [],
  records: { orders: [], ledger: [], flags: [], candles: [] }, acknowledged: null,
});
const sorted = <T extends number | string>(v: Iterable<T>) => [...new Set(v)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** One finding from a group of order hits: the most extreme value, every order behind it. */
function fromHits(rule: RuleId, g: Hit[], base: Level, limit: number | bigint, unit: Finding['measured']['unit'], st: State,
  facts: (top: Hit, orders: OrderRow[]) => Record<string, Fact>, extra: Partial<Finding> = {}): Finding {
  const top = g.reduce((a, h) => (h.value > a.value ? h : a));
  const orders = [...new Set(g.flatMap((h) => h.orders))].sort((a, b) => a.time - b.time || a.id - b.id);
  const start = Math.min(...g.map((h) => h.start)), end = Math.max(...g.map((h) => h.end));
  const f = blank(rule, `${g[0]!.subject}@${start}`);
  return {
    ...f, level: level(base, top.value, limit), start, end,
    players: sorted(orders.map((o) => o.player)).map((uuid) => ({ uuid, name: st.nameOf(uuid) })),
    markets: sorted(orders.map((o) => o.item)), accounts: sorted(orders.map((o) => o.account)),
    servers: sorted(orders.flatMap((o) => (o.server === null ? [] : [o.server]))),
    measured: { value: top.value, threshold: limit, unit }, facts: facts(top, orders),
    records: { ...f.records, orders: orders.map((o) => o.orderId ?? o.id) }, ...extra,
  };
}

// ---- What every rule reads once per workspace

interface State {
  orders: OrderRow[];
  byPlayer: Map<string, OrderRow[]>;
  nameOf: (uuid: string) => string;
  owner: Map<number, string>;
  reasons: Map<RuleId, string | null>;
  kept: Map<RuleId, { key: string; list: Finding[] }>;
}
const states = new WeakMap<DatabaseSync, State>();
export function state(db: DatabaseSync): State {
  let st = states.get(db);
  if (st) return st;
  const orders = readOrders(db, {}, null).filter((o) => o.time > 0); // orders without a time cannot be placed in time
  const byPlayer = new Map<string, OrderRow[]>();
  for (const o of orders) (byPlayer.get(o.player) ?? byPlayer.set(o.player, []).get(o.player)!).push(o);
  const owner = new Map(all(db, 'SELECT number, owner FROM account WHERE owner IS NOT NULL').map((r) => [num(r.number)!, String(r.owner)]));
  states.set(db, (st = { orders, byPlayer, nameOf: names(db), owner, reasons: new Map(), kept: new Map() }));
  return st;
}
const exists = (db: DatabaseSync, sql: string) => all(db, `SELECT EXISTS(${sql}) AS x`)[0]!.x === 1n;
const noOrders = (_db: DatabaseSync, st: State) => (st.orders.length ? null : 'The save has no market orders.');

// ---- The rules

/** A player buys and sells on one market, the sale more than `times` the price of a buy within `seconds`, no other player's order in between. */
export function roundTrips(orders: OrderRow[], times: number, seconds: number): Hit[] {
  const hits: Hit[] = [];
  const run = new Map<number, OrderRow[]>(); // per market: the orders of one player since another player's last order
  for (const o of orders) {
    let r = run.get(o.item);
    if (!r || r[0]!.player !== o.player) run.set(o.item, (r = []));
    if (o.amount < 0n) {
      let buy: OrderRow | null = null; // the cheapest buy in the window
      for (let i = r.length - 1; i >= 0 && o.time - r[i]!.time <= seconds * 1000; i--) if (r[i]!.amount > 0n && (!buy || r[i]!.price < buy.price)) buy = r[i]!;
      const x = buy && ratio(o.price, buy.price);
      if (buy && x! > times) {
        const qty = buy.amount < -o.amount ? buy.amount : -o.amount;
        hits.push({ subject: o.player, start: buy.time, end: o.time, value: x!, orders: [buy, o], facts: {
          bought: buy.amount, buyPrice: buy.price, sold: -o.amount, sellPrice: o.price, seconds: (o.time - buy.time) / 1000, profit: (qty * (o.price - buy.price)) / 100n,
        } });
      }
    }
    r.push(o);
  }
  return hits;
}

type Rule<K extends keyof RuleSettings> = { applies: (db: DatabaseSync, st: State) => string | null; run: (db: DatabaseSync, s: RuleSettings[K], st: State) => Finding[] };
const RULES: { [K in keyof RuleSettings]: Rule<K> } = {
  'round-trip': {
    applies: noOrders,
    run: (_db, s, st) => group(roundTrips(st.orders, s.times, s.seconds))
      .map((g) => fromHits('round-trip', g, 'high', s.times, 'times', st, (top) => ({ ...top.facts, rounds: g.length }))),
  },

  'order-rate': {
    applies: noOrders,
    run: (_db, s, st) => {
      const hits: Hit[] = [];
      for (const [player, list] of st.byPlayer) {
        let lo = 0;
        for (let hi = 0; hi < list.length; hi++) {
          while (list[hi]!.time - list[lo]!.time >= 1000) lo++;
          if (hi - lo + 1 > s.orders) hits.push({ subject: player, start: list[lo]!.time, end: list[hi]!.time, value: hi - lo + 1, orders: list.slice(lo, hi + 1), facts: {} });
        }
      }
      return group(hits).map((g) => fromHits('order-rate', g, 'medium', s.orders, 'orders', st, (top, orders) => ({
        busiestSecond: top.value as number, orders: orders.length, medianGapMs: Number(median(orders.slice(1).map((o, i) => BigInt(o.time - orders[i]!.time))) ?? 0n),
      })));
    },
  },

  'hour-profit': {
    applies: noOrders,
    run: (_db, s, st) => {
      const per = new Map<string, Map<number, { profit: bigint; orders: OrderRow[] }>>();
      const total = new Map<number, bigint>();
      for (const [player, list] of st.byPlayer) {
        const hours = new Map<number, { profit: bigint; orders: OrderRow[] }>();
        for (const sale of sales(list)) {
          const hour = Math.floor(sale.order.time / HOUR) * HOUR;
          const h = hours.get(hour) ?? hours.set(hour, { profit: 0n, orders: [] }).get(hour)!;
          h.profit += sale.profit;
          h.orders.push(sale.order);
          total.set(hour, (total.get(hour) ?? 0n) + sale.profit);
        }
        per.set(player, hours);
      }
      const hits: Hit[] = [];
      for (const [player, hours] of per) for (const [hour, h] of hours) {
        if (h.profit > s.money) hits.push({ subject: player, start: hour, end: hour + HOUR - 1, value: h.profit, orders: h.orders, facts: { hour, profit: h.profit, others: total.get(hour)! - h.profit } });
      }
      return group(hits).map((g) => fromHits('hour-profit', g, 'high', s.money, 'money', st, (top) => ({
        ...top.facts, hours: g.length, total: g.reduce((t, h) => t + (h.value as bigint), 0n),
      })));
    },
  },

  'far-price': {
    applies: noOrders,
    run: (_db, s, st) => {
      const hits: Hit[] = [];
      for (const o of st.orders) {
        const usual = usualAt(o.item, o.time); // the usual price at the time of the order (AT-45)
        if (usual === null || o.amount === 0n) continue;
        const x = o.price > usual ? ratio(o.price, usual) : ratio(usual, o.price);
        if (x > s.times) hits.push({ subject: `market ${o.item}`, start: o.time, end: o.time, value: x, orders: [o], facts: { price: o.price, usual } });
      }
      return group(hits).map((g) => fromHits('far-price', g, 'medium', s.times, 'times', st, (top, orders) => ({ ...top.facts, orders: orders.length })));
    },
  },

  'price-spike': {
    applies: (db) => (exists(db, 'SELECT 1 FROM candle') ? null : 'The save has no market prices.'),
    run: (db, s, st) => {
      // ponytail: one scan of every candle (14.1M on the November save); precompute high/low at import if it gets slow.
      // A low of 0 or 1 raw is the price floor: any move from there is a huge multiple and says little (318 of 460 hits on the
      // November save). Trades at the floor are caught by far-price and round-trip.
      const hits = all(db, 'SELECT market, time, low, high FROM candle WHERE low > 1 AND high > low * :n', { n: s.times }).map((r) => {
        const market = num(r.market)!, time = num(r.time)!, low = big(r.low)!, high = big(r.high)!;
        return { subject: `market ${market}`, start: time, end: time + MIN - 1, value: ratio(high, low), orders: [], facts: { time, low, high }, market };
      });
      return group(hits).map((g) => {
        const market = g[0]!.market, inside = st.orders.filter((o) => o.item === market && o.time >= g[0]!.start && o.time <= g.at(-1)!.end);
        return fromHits('price-spike', g, 'medium', s.times, 'times', st, (top) => ({ ...top.facts, usual: usualAt(market, g[0]!.start), minutes: g.length }), {
          markets: [market], records: { orders: [], ledger: [], flags: [], candles: g.map((h) => ({ market, time: h.start })) },
          // The players who traded in it are named, not blamed: their orders are not among the records.
          players: sorted(inside.map((o) => o.player)).map((uuid) => ({ uuid, name: st.nameOf(uuid) })), accounts: [], servers: [],
        });
      });
    },
  },

  'balance': {
    applies: (db) => (exists(db, 'SELECT 1 FROM snapshot') ? null : 'The save has no balance snapshots.'),
    run: (db, s, st) => {
      const limit = threshold(db, s), money = moneyItems(db);
      return allGaps().filter((g) => abs(g.difference) > limit(g.item)).map((g): Finding => {
        const owner = st.owner.get(g.account);
        return {
          ...blank('balance', `${g.account}:${g.item}@${g.from}`), level: level(g.rating, abs(g.difference), limit(g.item)), start: g.from, end: g.to,
          players: owner ? [{ uuid: owner, name: st.nameOf(owner) }] : [], accounts: [g.account],
          measured: { value: abs(g.difference), threshold: limit(g.item), unit: money.has(g.item) ? 'money' : 'items' },
          facts: { item: g.item, difference: g.difference, labels: g.labels, rating: g.rating },
        };
      });
    },
  },

  'order-ledger': {
    applies: (db) => (exists(db, "SELECT 1 FROM ledger WHERE kind IN ('TRADE_BUY', 'TRADE_SELL')") ? null
      : 'The bank log of this save has no trade rows, so there is nothing to compare the orders with.'),
    run: (db, _s, st) => {
      // The rows of an order are deltas (CLOSE, PERIODIC, SHUTDOWN) with ref sm:order:<id>; together they make its volume.
      const logged = new Map(all(db, `SELECT ref, sum(amount) AS v, group_concat(id) AS ids FROM ledger WHERE kind IN ('TRADE_BUY', 'TRADE_SELL') AND ref LIKE 'sm:order:%' GROUP BY ref`)
        .map((r) => [Number(String(r.ref).slice(9)), { volume: big(r.v)!, ids: String(r.ids).split(',').map(Number) }]));
      const first = num(all(db, "SELECT min(ts) AS t FROM ledger WHERE kind IN ('TRADE_BUY', 'TRADE_SELL')")[0]!.t)!;
      const hits: (Hit & { ids: number[] })[] = [];
      for (const o of st.orders) {
        // Inter-market legs are logged under sm:im:<uuid>; orders that finished before the first trade row predate the logging.
        if (o.orderId === null || o.type === 'intermarket' || (o.finishMs ?? o.time) < first) continue;
        const l = logged.get(o.orderId), volume = abs(o.amount), got = l?.volume ?? 0n;
        if (got !== volume) hits.push({ subject: o.player, start: o.time, end: o.finishMs ?? o.time, value: abs(volume - got), orders: [o], facts: { volume, logged: got }, ids: l?.ids ?? [] });
      }
      return group(hits).map((g) => {
        const f = fromHits('order-ledger', g, 'medium', 0n, 'items', st, (top, orders) => ({ ...top.facts, orders: orders.length }));
        return { ...f, level: 'medium', measured: { ...f.measured, threshold: null }, records: { ...f.records, ledger: g.flatMap((h) => h.ids).sort((a, b) => a - b) } };
      });
    },
  },

  'bank-flag': {
    applies: (db) => (mainSave()?.sources.find((x) => x.id === 'bank')?.tables.some((t) => t.name === 'SuspicionFlag') || exists(db, "SELECT 1 FROM audit WHERE kind = 'FLAG'") ? null
      : 'This save has no flag table: the bank mod raises flags from version 2.2.0 on.'),
    run: (db, _s, st) => {
      const audit = bankSettings(db);
      const money = (key: string) => (typeof audit[key] === 'number' ? BigInt(Math.round((audit[key] as number) * 100)) : null);
      const limit: Record<number, bigint | null> = { 1: money('LAUNDERING_MIN_AMOUNT'), 2: money('LARGE_NOTE_WITHDRAWAL_AMOUNT'), 3: money('WEALTH_JUMP_AMOUNT'),
        4: money('NEW_ACCOUNT_TRANSFER_AMOUNT'), 5: money('MONEY_SUPPLY_GROWTH_AMOUNT') };
      const fromDb = all(db, 'SELECT * FROM flag ORDER BY ts, id').map((r): Finding => {
        const id = num(r.id)!, type = num(r.flag_type)!, severity = num(r.severity)!, account = num(r.account)!, amount = big(r.amount)!;
        const owner = st.owner.get(account);
        return {
          ...blank('bank-flag', String(id)), basis: 'as raised', source: 'bank mod', start: num(r.ts)!, end: num(r.ts)!,
          // The mod's severity 1, 2, 3 are medium, high, critical; 0 comes from a migrated table.
          level: severity >= 3 ? 'critical' : severity === 2 ? 'high' : severity === 1 ? 'medium' : 'low',
          players: owner ? [{ uuid: owner, name: st.nameOf(owner) }] : [], accounts: account === 0 ? [] : [account], // flag 5 is raised on account 0
          measured: { value: amount, threshold: limit[type] ?? null, unit: type <= 6 ? 'money' : type === 7 ? 'items' : 'shares' },
          facts: { flagType: type, severity, amount, ref: text(r.ref), details: text(r.details) },
          records: { orders: [], ledger: [], flags: [id], candles: [] }, acknowledged: r.acknowledged === 1n,
        };
      });
      // A FLAG entry of the audit log without its flag row: a row the database lost. Whether it was acknowledged is unknown.
      const fromLog = all(db, "SELECT * FROM audit WHERE kind = 'FLAG' AND row_id IS NULL AND ts IS NOT NULL ORDER BY ts, id").map((r): Finding => {
        const type = Number(r.type), severity = num(r.severity)!, account = num(r.account)!, amount = big(r.amount)!, ts = num(r.ts)!;
        const owner = st.owner.get(account);
        return {
          ...blank('bank-flag', `log@${num(r.local)}:${account}:${type}`), basis: 'as raised', source: 'bank mod', start: ts, end: ts,
          level: severity >= 3 ? 'critical' : severity === 2 ? 'high' : severity === 1 ? 'medium' : 'low',
          players: owner ? [{ uuid: owner, name: st.nameOf(owner) }] : [], accounts: account === 0 ? [] : [account],
          measured: { value: amount, threshold: limit[type] ?? null, unit: type <= 6 ? 'money' : type === 7 ? 'items' : 'shares' },
          facts: { flagType: type, severity, amount, ref: text(r.ref), details: text(r.text), origin: 'audit log', approximateTime: r.approx === 1n },
        };
      });
      return [...fromDb, ...fromLog].sort((a, b) => a.start - b.start);
    },
  },

  'market-alert': {
    applies: () => (mainSave()?.sources.find((x) => x.id === 'marketDiag')?.tables.some((t) => t.name === 'TradeAlert') ? null
      : 'This save has no alert table: the market mod stores its alerts from SM-316 on. Before that they were only in the server log.'),
    run: (db, _s, st) => all(db, 'SELECT * FROM trade_alert ORDER BY ts, id').map((r): Finding => {
      const id = num(r.id)!, ts = num(r.ts)!, kind = String(r.kind), player = text(r.player), account = num(r.account), item = num(r.item);
      const amount = big(r.amount) ?? 0n, stored = r.threshold === null ? null : Number(r.threshold);
      const ids = orderIds(text(r.order_ids));
      const orders = ids.length ? readOrders(db, { ids }, null) : [];
      const ledger = ids.length ? all(db, "SELECT id FROM ledger WHERE ref IN (SELECT 'sm:order:' || value FROM json_each(:ids)) ORDER BY ts, id", { ids: JSON.stringify(ids) }).map((x) => num(x.id)!) : [];
      let measured: Finding['measured'] = { value: amount, threshold: stored === null ? null : BigInt(Math.round(stored * 100)), unit: 'money' };
      const facts: Record<string, Fact> = { kind, amount, windowMs: num(r.window_ms), threshold: stored, text: text(r.text) };
      if (kind === 'pump_dump_pump') {
        // The mod compares the rise with the price at the start of the tick, which no save keeps: the minute's open stands in.
        const open = item === null ? null : big(all(db, 'SELECT open FROM candle WHERE market = :m AND time <= :t AND time > :t - 60000 ORDER BY time DESC LIMIT 1', { m: item, t: ts })[0]?.open ?? null);
        const pct = open !== null && open > 0n ? (Number(amount) / Number(open)) * 100 : null;
        Object.assign(facts, { open, percent: pct });
        measured = pct === null ? { value: amount, threshold: null, unit: 'money' } : { value: pct, threshold: stored, unit: 'percent' };
      }
      return {
        ...blank('market-alert', String(id)), basis: 'as raised', source: 'market mod', start: ts, end: ts,
        level: level('medium', measured.value, measured.threshold),
        players: player ? [{ uuid: player, name: st.nameOf(player) }] : [], markets: item === null ? [] : [item], accounts: account === null ? [] : [account],
        servers: sorted(orders.flatMap((o) => (o.server === null ? [] : [o.server]))),
        measured, facts, records: { orders: ids, ledger, flags: [], candles: [] },
      };
    }),
  },

  'last-save': {
    applies: (db) => (lastSave(db) === null ? 'The bank\'s diagnostics file of this save does not record when the bank last saved.' : null),
    run: (db, _s, st) => {
      const save = lastSave(db)!;
      const rows = all(db, 'SELECT id, ts, account FROM ledger WHERE ts > :t ORDER BY ts, id', { t: save });
      if (!rows.length) return [];
      const accounts = sorted(rows.map((r) => num(r.account)!));
      return [{
        ...blank('last-save', 'after-save'), basis: 'hint', level: 'low', start: num(rows[0]!.ts)!, end: num(rows.at(-1)!.ts)!, accounts,
        players: sorted(accounts.flatMap((a) => st.owner.get(a) ?? [])).map((uuid) => ({ uuid, name: st.nameOf(uuid) })),
        measured: { value: rows.length, threshold: null, unit: 'rows' },
        facts: { lastSave: save, rows: rows.length }, records: { orders: [], ledger: rows.map((r) => num(r.id)!), flags: [], candles: [] },
      }];
    },
  },

  'transfer': {
    applies: () => noTransfers(),
    // One finding per transfer id of the classes that mean value went wrong; ok, the known and data gaps
    // and transfers newer than a copy are on the Transfers tab only.
    // Measured: the item furthest off in the class's direction (more arrived for twice and created, less for lost, either
    // way for parked), so the title's item and words agree.
    run: () => allTransfers().filter((t) => FLAGGED.has(t.class)).map((t): Finding => {
      const way = t.class === 'lost' ? -1n : t.class === 'parked' ? 0n : 1n;
      const off = (i: TransferItem) => (way === 0n ? (i.received > i.sent ? i.received - i.sent : i.sent - i.received) : way * (i.received - i.sent));
      const top = t.items.reduce<TransferItem | null>((a, i) => (a === null || off(i) > off(a) ? i : a), null) ?? { item: null, sent: 0n, received: 0n };
      return {
        ...blank('transfer', t.id), level: 'high', start: t.start, end: t.end,
        players: t.player ? [t.player] : [], accounts: t.account === null ? [] : [t.account], servers: t.server === null ? [] : [t.server],
        measured: { value: top.sent > top.received ? top.sent - top.received : top.received - top.sent, threshold: null, unit: top.item === null ? 'money' : 'items' },
        facts: { transferId: t.id, class: t.class, direction: t.direction, path: t.path, item: top.item, sent: top.sent, received: top.received,
          itemsOff: t.items.filter((i) => i.sent !== i.received).length, steps: t.steps, why: t.why },
        records: { orders: [], ledger: t.ledger, flags: t.flags, candles: [] },
      };
    }),
  },

  'banknotes': {
    applies: () => banknotes(EVER).reason ?? worldItems().reason,
    // The notes the log says are outside the bank against those found in the player files and by the region scan.
    // An estimate: the scan may not have run, and players without a file are not counted.
    run: (db, s) => {
      const count = banknotes(EVER), world = worldItems();
      const diff = world.notes - count.outstanding;
      if (abs(diff) <= s.money) return [];
      const main = mainSave()!;
      const span = all(db, 'SELECT min(ts) AS a, max(ts) AS b FROM ledger WHERE ts > 0')[0]!;
      const end = main.lastPlayedMs ?? num(span.b) ?? 0, start = Math.min(num(span.a) ?? end, end);
      const named = (l: { name: string }[]) => l.map((p) => p.name);
      const scan = world.scan, u = scan.unreadable;
      return [{
        ...blank('banknotes', 'count'), basis: 'estimate', level: level('medium', abs(diff), s.money), start, end,
        measured: { value: abs(diff), threshold: s.money, unit: 'money' },
        facts: { outstanding: count.outstanding, found: world.notes, difference: diff, inventory: world.inventory, enderChest: world.enderChest,
          blocks: world.blocks, offers: world.offers, putBack: count.putBack, appeared: count.appeared.reduce((a, g) => a + g.amount, 0n),
          missing: named(world.missing), unnamed: world.unnamed, unreadable: named(world.unreadable), without: world.without,
          scan: scan.state, scanFiles: scan.files, scanFilesTotal: scan.filesTotal, chunksUnread: u.damaged + u.lz4 + u.tooLarge, lz4: u.lz4, filesUnread: u.files },
      }];
    },
  },
};
const EVER: Scope = { from: null, to: null, server: null };
const FLAGGED = new Set(['lost', 'twice', 'created', 'parked']);

/** bank_last_save_ms is decimal text in the bank's diagnostics Meta; null when missing or not a number. */
function lastSave(db: DatabaseSync): number | null {
  const v = text(all(db, "SELECT value FROM diag_meta WHERE source = 'bank' AND key = 'bank_last_save_ms'")[0]?.value ?? null);
  return v !== null && /^\d{1,16}$/.test(v.trim()) ? Number(v) : null;
}
function bankSettings(db: DatabaseSync): Record<string, number | boolean> {
  try {
    return JSON.parse(text(all(db, "SELECT value FROM meta WHERE key = 'bank_audit'")[0]?.value ?? null) ?? '{}') as Record<string, number | boolean>;
  } catch {
    return {};
  }
}

/** An alert's order_ids: up to 1000 comma-separated order ids. Anything else gives none. */
export function orderIds(v: string | null): number[] {
  if (v === null || !/^\s*\d{1,15}(\s*,\s*\d{1,15}){0,999}\s*$/.test(v)) return [];
  return [...new Set(v.split(',').map((x) => Number(x.trim())))];
}

/** Overlaps the time range, and under a server filter was placed there or has no server. Findings and incidents alike. */
export const shown = (x: { start: number; end: number; servers: string[] }, scope: Scope) =>
  (scope.from === null || x.end >= scope.from) && (scope.to === null || x.start <= scope.to)
  && (scope.server === null || x.servers.length === 0 || x.servers.includes(scope.server));

export function findings(scope: Scope, settings: RuleSettings): FindingsResult {
  const db = mainData();
  const rules: RuleStatus[] = [];
  const out: Finding[] = [];
  if (!db) {
    for (const rule of Object.keys(RULES) as (keyof RuleSettings)[]) rules.push({ rule, on: settings[rule].on, found: null, notApplicable: 'No save with bank or market data is loaded.' });
  } else {
    const st = state(db);
    for (const rule of Object.keys(RULES) as (keyof RuleSettings)[]) {
      const r = RULES[rule] as Rule<typeof rule>, s = settings[rule];
      if (!st.reasons.has(rule)) st.reasons.set(rule, r.applies(db, st));
      const reason = st.reasons.get(rule)!;
      if (!s.on || reason !== null) {
        rules.push({ rule, on: s.on, found: null, notApplicable: reason });
        continue;
      }
      // The banknote rule reads the region scan, which can change while the tool runs.
      const key = JSON.stringify(s, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)) + (rule === 'banknotes' ? ':' + scanStamp() : '');
      let kept = st.kept.get(rule);
      if (kept?.key !== key) st.kept.set(rule, (kept = { key, list: r.run(db, s as never, st) }));
      rules.push({ rule, on: true, found: kept.list.length, notApplicable: null });
      out.push(...kept.list.filter((f) => shown(f, scope)));
    }
  }
  out.sort((a, b) => RANK[a.level] - RANK[b.level] || a.start - b.start || (a.id < b.id ? -1 : 1));
  return { findings: out, rules, bankSettings: db ? bankSettings(db) : {} };
}

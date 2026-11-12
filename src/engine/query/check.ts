// The check per account (DESIGN_SPEC 8.4): for every account and item, every gap between two neighbouring snapshots,
// the change of free plus locked against what the ledger (or, before the save has trade rows, the orders) explains.
// Accounts that are gone from the bank's files are checked too: everything here starts from the snapshot and ledger rows.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Gap, ItemCheck, Rating, RuleSettings, Scope } from '../../shared/api.ts';
import { mainData, mainSave } from '../workspace.ts';
import { all, big, num, text } from './db.ts';
import { change } from './players.ts';

const WEALTH = 32767; // the bank's wealth series, a sum and not an item
/** Neighbouring differences that cancel are joined when both lie within this time (DESIGN_SPEC 8.4). */
const JOIN_MS = 15 * 60_000;
/** They cancel when what is left is at most 1% of the larger one: order money is cut off per fill (DATA_SOURCES, known gaps). */
const cancels = (a: bigint, b: bigint) => (a > 0n) !== (b > 0n) && abs(a + b) * 100n <= (abs(a) > abs(b) ? abs(a) : abs(b));
const abs = (v: bigint) => (v < 0n ? -v : v);

/** What one row or order did to one balance. raw: RAW_CHANGE from an unknown source; unknown: a row whose sign the save does not give. */
interface Move { ts: number; how: 'trade' | 'raw' | 'row' | 'unknown'; amount: bigint; kind: string }
interface RawGap { from: number; to: number; diff: bigint; trades: bigint; paidIn: bigint; paidOut: bigint; labels: string[] }
type Series = [number, bigint][];

/**
 * How much a gap says (DESIGN_SPEC 8.4). Below 2.2.0 trades and admin actions are not logged: low. From the first row
 * only BS-254 writes (types 29 to 31) nearly every change has a row: high. Every other gap: medium. No version: low.
 */
export function rate(version: string | null, firstBs254: number | null, from: number): Rating {
  const [major = 0, minor = 0] = (version ?? '').split('.').map((p) => parseInt(p, 10) || 0);
  if (version === null || major < 2 || (major === 2 && minor < 2)) return 'low';
  return firstBs254 !== null && from >= firstBs254 ? 'high' : 'medium';
}

/** Snapshots and moves per "account:item", oldest first; one account or all of them. */
function read(db: DatabaseSync, account: number | null) {
  const params: Record<string, SQLInputValue> = account === null ? {} : { account };
  const only = account === null ? '' : 'AND account = :account';

  const snaps = new Map<string, Series>();
  for (const r of all(db, `SELECT account, item, time, balance + locked AS v FROM snapshot WHERE item != ${WEALTH} ${only} ORDER BY account, item, time, id`, params)) {
    const key = `${r.account}:${r.item}`, t = num(r.time)!, v = big(r.v)!;
    const s = snaps.get(key) ?? snaps.set(key, []).get(key)!;
    if (s.at(-1)?.[0] === t) s.at(-1)![1] = v; // two at the same time: the later one counts
    else s.push([t, v]);
  }

  const moves = new Map<string, Move[]>();
  const add = (acc: number, item: number, m: Move) => {
    if (m.how === 'row' && m.amount === 0n) return; // a freeze, an unlock, a share stamp: no change
    const key = `${acc}:${item}`;
    (moves.get(key) ?? moves.set(key, []).get(key)!).push(m);
  };
  for (const r of all(db, `SELECT ts, account, kind, item, amount, note, balance_after, source_kind, money_amount, currency_item FROM ledger
    WHERE 1 ${only} ORDER BY ts, id`, params)) {
    const ts = num(r.ts)!, acc = num(r.account)!, kind = String(r.kind);
    const c = change(kind, big(r.amount)!, text(r.note), big(r.balance_after));
    const trade = kind === 'TRADE_BUY' || kind === 'TRADE_SELL';
    add(acc, num(r.item)!, { ts, kind, amount: c ?? 0n, how: c === null ? 'unknown' : trade ? 'trade' : kind === 'RAW_CHANGE' && r.source_kind === 'UNKNOWN' ? 'raw' : 'row' });
    if (trade && r.money_amount !== null && r.currency_item !== null) {
      const paid = big(r.money_amount)!;
      add(acc, num(r.currency_item)!, { ts, kind, how: 'trade', amount: kind === 'TRADE_BUY' ? -paid : paid });
    }
  }

  const first = all(db, `SELECT min(CASE WHEN kind IN ('TRADE_BUY', 'TRADE_SELL') THEN ts END) AS trade,
    min(CASE WHEN type_code IN (29, 30, 31) OR kind IN ('RAW_CHANGE', 'EXTERNAL_BIND', 'EXTERNAL_UNBIND') THEN ts END) AS bs254 FROM ledger`)[0]!;
  // Orders stand in for trades before the first trade row, all of them on a save without one. Goods and money on the
  // order's account, when it finished if the save says so, else when it was placed. Money is the lowest money item.
  const firstTrade = num(first.trade);
  const money = num(all(db, 'SELECT min(id) AS id FROM item WHERE money = 1')[0]!.id);
  if (firstTrade !== null) params.first = firstTrade;
  for (const r of all(db, `SELECT account, item, amount, price, coalesce(finish_time, time) AS ts FROM orders
    WHERE time > 0 ${only} ${firstTrade !== null ? 'AND coalesce(finish_time, time) < :first' : ''}`, params)) {
    const ts = num(r.ts)!, acc = num(r.account)!, amount = big(r.amount)!;
    add(acc, num(r.item)!, { ts, kind: 'ORDER', how: 'trade', amount });
    if (money !== null) add(acc, money, { ts, kind: 'ORDER', how: 'trade', amount: -(amount * big(r.price)!) / 100n }); // as readOrders: cut off
  }
  for (const list of moves.values()) list.sort((a, b) => a.ts - b.ts);

  const version = mainSave()?.bankVersion ?? null, bs254 = num(first.bs254);
  return { snaps, moves, rating: (from: number) => rate(version, bs254, from) };
}

/** The gaps of one series. A row at a snapshot's own millisecond belongs to the gap that ends there; rows up to the first snapshot are in its balance. */
function gaps(s: Series, list: Move[]): RawGap[] {
  const out: RawGap[] = [];
  let i = 0;
  while (i < list.length && list[i]!.ts <= s[0]![0]) i++;
  for (let k = 1; k < s.length; k++) {
    const [from, before] = s[k - 1]!, [to, after] = s[k]!;
    let trades = 0n, raw = 0n, paidIn = 0n, paidOut = 0n;
    const labels = new Set<string>();
    for (; i < list.length && list[i]!.ts <= to; i++) {
      const m = list[i]!;
      if (m.how === 'trade') trades += m.amount;
      else if (m.how === 'raw') raw += m.amount;
      else if (m.how === 'unknown') labels.add(m.kind);
      else if (m.amount > 0n) paidIn += m.amount;
      else paidOut -= m.amount;
    }
    // BS-254 with a StockMarket before SM-318 logs a fill twice: a trade row and RAW_CHANGE rows from an unknown source.
    // Trade rows are deltas and RAW_CHANGE is per settlement, so they are paired per gap: raw change in the trades'
    // direction counts once, up to the trades' amount.
    // ponytail: a PERIODIC trade row comes up to 10 minutes after its fills; when a snapshot falls in between, the pair
    // lands in two gaps and is left as two differences that the join below usually cancels. Pair across gaps if it does not.
    if (trades !== 0n && raw !== 0n && (raw > 0n) === (trades > 0n)) raw -= abs(raw) < abs(trades) ? raw : trades;
    if (raw > 0n) paidIn += raw;
    else paidOut -= raw;
    out.push({ from, to, diff: after - before - trades - paidIn + paidOut, trades, paidIn, paidOut, labels: [...labels] });
  }
  return out;
}

/** Gaps with a difference; neighbours whose differences cancel within 15 minutes become one gap with the summed difference. */
function join(list: RawGap[]): RawGap[] {
  const out: RawGap[] = [];
  for (const g of list) {
    if (g.diff === 0n) continue;
    const prev = out.at(-1);
    if (prev && prev.diff !== 0n && g.to - prev.from <= JOIN_MS && cancels(prev.diff, g.diff)) {
      out[out.length - 1] = { ...prev, to: g.to, diff: prev.diff + g.diff, labels: [...new Set([...prev.labels, ...g.labels])] };
    } else out.push(g);
  }
  return out.filter((g) => g.diff !== 0n);
}

const gap = (g: RawGap, rating: (from: number) => Rating): Gap => ({ from: g.from, to: g.to, difference: g.diff, labels: g.labels, rating: rating(g.from) });

export const moneyItems = (db: DatabaseSync) => new Set(all(db, 'SELECT id FROM item WHERE money = 1').map((r) => num(r.id)!));
/** The "Balance not explained" threshold of an item: money or goods (DESIGN_SPEC 8.2). */
export function threshold(db: DatabaseSync, s: RuleSettings['balance']) {
  const money = moneyItems(db);
  return (item: number) => (money.has(item) ? s.money : s.items);
}

/** Per item of the account: the sum from the first to the last snapshot in the scope, and its gaps above the threshold. */
export function check(account: number, scope: Scope, settings: RuleSettings): ItemCheck[] {
  const db = mainData();
  if (!db) return [];
  const { snaps, moves, rating } = read(db, account);
  const limit = threshold(db, settings.balance);
  const items = [...new Set([...snaps.keys(), ...moves.keys()])].map((k) => Number(k.split(':')[1])).sort((a, b) => a - b);
  return items.map((item): ItemCheck => {
    const whole = snaps.get(`${account}:${item}`) ?? [];
    // Start at the last snapshot at or before the range's start (else the first one), end at the last one at or before its end.
    const start = Math.max(0, scope.from === null ? 0 : whole.findLastIndex(([t]) => t <= scope.from!));
    const end = scope.to === null ? whole.length - 1 : whole.findLastIndex(([t]) => t <= scope.to!);
    const s = end >= start ? whole.slice(start, end + 1) : [];
    const raw = s.length > 1 ? gaps(s, moves.get(`${account}:${item}`) ?? []) : [];
    const sum = (f: (g: RawGap) => bigint) => raw.reduce((t, g) => t + f(g), 0n);
    const trades = sum((g) => g.trades), paidIn = sum((g) => g.paidIn), paidOut = sum((g) => g.paidOut);
    const first = s[0]?.[1] ?? null, is = s.at(-1)?.[1] ?? null;
    const shouldBe = first === null ? null : first + trades + paidIn - paidOut;
    const list = join(raw).filter((g) => abs(g.diff) > limit(item)).map((g) => gap(g, rating));
    return {
      item, start: first, trades, paidIn, paidOut, shouldBe, is, unexplained: is === null ? 0n : is - shouldBe!, gaps: list,
      verdict: s.length < 2 ? 'unchecked' : list.length === 0 ? 'explained' : list.some((g) => g.labels.length === 0) ? 'unexplained' : 'unknown-rows',
    };
  });
}

/** Every gap with a difference over all accounts and items, for the rule "Balance not explained". Not on the API. */
export function allGaps(): (Gap & { account: number; item: number })[] {
  const db = mainData();
  if (!db) return [];
  const { snaps, moves, rating } = read(db, null);
  return [...snaps].flatMap(([key, s]) => {
    const [account, item] = key.split(':').map(Number) as [number, number];
    return join(gaps(s, moves.get(key) ?? [])).map((g) => ({ account, item, ...gap(g, rating) }));
  });
}

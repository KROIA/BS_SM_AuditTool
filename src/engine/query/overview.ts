// What the Overview asks: money and wealth over time, the top lists, and the key events of its chart.
import type { KeyEvent, Overview, RuleSettings, Scope } from '../../shared/api.ts';
import { isOpen } from '../../shared/incident.ts';
import { dismissedIds, mainData } from '../workspace.ts';
import { adminEvents } from './admin.ts';
import { moneyItems } from './check.ts';
import { all, big, num, series } from './db.ts';
import { findings } from './findings.ts';
import { incidents } from './incidents.ts';
import { source, usualAt } from './markets.ts';
import { players } from './players.ts';

const WEALTH = 32767; // the bank's wealth series: money plus items at market price, per account
const abs = (v: bigint) => (v < 0n ? -v : v);
const larger = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);

export function overview(scope: Scope): Overview {
  const db = mainData();
  if (!db) return { money: [], wealth: null, moneyNow: 0n, top: [], unusual: [] };
  const money = [...moneyItems(db)].join(',') || '-1';
  const snaps = (items: string) => series(all(db, `SELECT account, item, time, balance + locked AS v FROM snapshot WHERE item IN (${items})
    ${scope.to !== null ? 'AND time <= :to' : ''} ORDER BY time, id`, scope.to !== null ? { to: scope.to } : {}), scope);
  const wealth = snaps(String(WEALTH));
  // Each market's highest high and lowest low in the range, with the time of that candle (SQLite fills the bare column
  // `time` from the row that holds the max or min). Each extreme is compared with the usual price at its own time
  // (AT-45). The usual price follows the market, so it need not lie between low and high and the swing no
  // longer caps the factor: every market is asked, with no early stop. Bounded: two scans of the hour candles of the range
  // (as markets() does) and at most two usualAt reads per market, each at most 1'440 index rows, cached per hour.
  const src = source(scope, null), extreme = (agg: string) => new Map(all(db, `SELECT market, ${agg} AS v, time FROM (${src.sql}) GROUP BY market`, src.params)
    .map((r) => [num(r.market)!, { v: big(r.v)!, time: num(r.time)! }] as const));
  const lows = extreme('min(low)');
  const unusual: Overview['unusual'] = [];
  for (const [item, hi] of extreme('max(high)')) {
    const lo = lows.get(item)!;
    const uHi = usualAt(item, hi.time), uLo = usualAt(item, lo.time);
    // A low at the price floor (0 or 0.01) says nothing: from there any price is a huge multiple.
    const up = uHi !== null && uHi > 0n ? Number(hi.v) / Number(uHi) : 0, down = uLo !== null && lo.v > 1n ? Number(uLo) / Number(lo.v) : 0;
    const times = Math.max(up, down);
    if (times < 2) continue;
    unusual.push({ item, low: lo.v, high: hi.v, usual: down > up ? uLo! : uHi!, times, below: down > up });
  }
  unusual.sort((a, b) => b.times - a.times || a.item - b.item).splice(4);
  return {
    money: snaps(money),
    wealth: wealth.length ? wealth : null,
    moneyNow: big(all(db, 'SELECT coalesce(sum(b.balance + b.locked), 0) AS v FROM balance b JOIN item i ON i.id = b.item AND i.money = 1')[0]!.v)!,
    top: players(scope).filter((p) => p.profit > 0n).slice(0, 5),
    unusual,
  };
}

/**
 * The strongest few moments of the range: up to 3 open incidents, the 2 largest money gaps of the check outside them,
 * the 2 largest admin actions on money and 2 rights or trust changes. Oldest first, so their numbers follow the chart from left to right.
 */
export function keyEvents(scope: Scope, settings: RuleSettings): KeyEvent[] {
  const db = mainData();
  if (!db) return [];
  const dismissed = dismissedIds(), off = (id: string) => dismissed.has(id), money = moneyItems(db);
  const open = incidents(scope, settings).incidents.filter((i) => isOpen(i, off)).slice(0, 3);
  const taken = new Set(open.flatMap((i) => i.findings));
  const gaps = findings(scope, settings).findings
    .filter((f) => f.rule === 'balance' && !off(f.id) && !taken.has(f.id) && money.has(Number(f.facts.item)))
    .sort((a, b) => larger(abs(a.facts.difference as bigint), abs(b.facts.difference as bigint))).slice(0, 2);
  const actions = adminEvents(scope);
  const admin = actions.filter((a) => a.amount !== null && a.amount !== 0n && a.item !== null && money.has(a.item))
    .sort((a, b) => larger(abs(a.amount!), abs(b.amount!))).slice(0, 2);
  // Rights and trust changes (BS-257): the 2 closest to a listed incident, else the latest.
  const near = (t: number) => Math.min(Infinity, ...open.map((i) => Math.abs(i.start - t)));
  const rights = actions.filter((a) => /^(RIGHTS|SLAVE)_/.test(a.type)).sort((a, b) => near(a.time) - near(b.time) || b.time - a.time).slice(0, 2);
  return [
    ...open.map((incident): KeyEvent => ({ kind: 'incident', time: incident.start, incident })),
    ...gaps.map((finding): KeyEvent => ({ kind: 'gap', time: finding.end, finding })),
    ...[...admin, ...rights].map((a): KeyEvent => ({ kind: 'admin', time: a.time, admin: a })),
  ].sort((a, b) => a.time - b.time);
}

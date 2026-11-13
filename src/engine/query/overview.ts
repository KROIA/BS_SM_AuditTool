// What the Overview asks (DESIGN_SPEC 6.1): money and wealth over time, the top lists, and the key events of its chart.
import type { KeyEvent, Overview, RuleSettings, Scope } from '../../shared/api.ts';
import { isOpen } from '../../shared/incident.ts';
import { dismissedIds, mainData } from '../workspace.ts';
import { adminEvents } from './admin.ts';
import { moneyItems } from './check.ts';
import { all, big, series } from './db.ts';
import { findings } from './findings.ts';
import { incidents } from './incidents.ts';
import { markets, usualPrice } from './markets.ts';
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
  // The usual price takes a sort of every 1-minute candle of a market (about 25 ms each on a real save), so only the
  // markets with the largest swing are asked, and the search stops once no swing can beat the 4th entry: over all data
  // the usual price lies between low and high, so the swing caps the factor and the list is exact.
  // ponytail: in a shorter range the usual price can lie outside it; then only the 12 largest swings are looked at.
  const unusual: Overview['unusual'] = [];
  let asked = 0;
  for (const m of markets(scope)) { // largest swing first
    if (m.swing === null || m.swing < 2 || asked === 12 || (unusual.length === 4 && m.swing <= unusual[3]!.times)) break;
    asked++;
    const usual = usualPrice(m.item);
    if (usual === null || usual <= 0n) continue;
    // A low at the price floor (0 or 0.01) says nothing: from there any price is a huge multiple (DESIGN_SPEC 8.2, price spike).
    const up = Number(m.high) / Number(usual), down = m.low! > 1n ? Number(usual) / Number(m.low) : 0;
    const times = Math.max(up, down);
    if (times < 2) continue;
    unusual.push({ item: m.item, low: m.low!, high: m.high!, usual, times, below: down > up });
    unusual.sort((a, b) => b.times - a.times).splice(4);
  }
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
  // Rights and trust changes (BS-257, DESIGN_SPEC 7): the 2 closest to a listed incident, else the latest.
  const near = (t: number) => Math.min(Infinity, ...open.map((i) => Math.abs(i.start - t)));
  const rights = actions.filter((a) => /^(RIGHTS|SLAVE)_/.test(a.type)).sort((a, b) => near(a.time) - near(b.time) || b.time - a.time).slice(0, 2);
  return [
    ...open.map((incident): KeyEvent => ({ kind: 'incident', time: incident.start, incident })),
    ...gaps.map((finding): KeyEvent => ({ kind: 'gap', time: finding.end, finding })),
    ...[...admin, ...rights].map((a): KeyEvent => ({ kind: 'admin', time: a.time, admin: a })),
  ].sort((a, b) => a.time - b.time);
}

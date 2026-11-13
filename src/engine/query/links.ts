// Connected players: who is linked to a player, and how sure it is. Proven: a shared account or a
// transfer between their accounts. Likely: notes one withdrew and the other paid in, the exact amount within a day.
// Weak: both traded the same market in trading sessions that overlap. Never a finding of its own.
import type { SQLInputValue } from 'node:sqlite';
import type { LinkStrength, LinkWay, OrderRow, PlayerLink, Scope } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { countNotes } from './banknotes.ts';
import { all, big, names, num, text } from './db.ts';
import { change, onServer, readOrders } from './players.ts';
import { split } from './sessions.ts';

const DAY = 24 * 3_600_000;
const TRANSFER = ['TRANSFER', 'TRANSFER_IN', 'TRANSFER_OUT'];
/** Players linked by trading alone, and markets per player, kept: the most overlap first. */
const WEAK_PLAYERS = 5, MARKETS = 3;
const NEAR = 5 * 60_000;
const RANK: Record<LinkStrength, number> = { proven: 0, likely: 1, weak: 2 };

/** Notes one player withdrew and another paid in: the exact amount, paid in after it and at most a day later. */
export interface NoteMatch {
  out: string;
  in: string;
  amount: bigint;
  /** One withdrawal, or a run of up to RUN of one player's withdrawals that add up to the amount; oldest first. */
  withdrawn: { id: number; account: number; ts: number }[];
  /** id null: money that appeared on a 2.1.2 account without a row, sometime between from and to. */
  paidIn: { id: number | null; account: number; from: number; to: number };
}

/** The longest run of one player's withdrawals that a deposit may add up. */
const RUN = 10;

/**
 * Every note match in the range. On 2.1.2 the money that appeared without a row ("likely notes paid in", banknotes.ts) is
 * paid in by the account's owner. Deposits are matched oldest first and each withdrawal goes to at most one of them. Per
 * deposit: the latest single withdrawal of the exact amount by any other player; else, per other player, a run of their
 * consecutive withdrawals in the window, newest first, whose running sum is exactly the amount (the latest run wins).
 */
export function noteMatches(scope: Scope): NoteMatch[] {
  const { result, moves } = countNotes(scope);
  const inRange = (ts: number) => scope.from === null || ts >= scope.from;
  const outs = moves.filter((m) => m.id !== null && m.account !== null && m.player !== null && m.delta > 0n && inRange(m.ts)); // oldest first
  const ins = [
    ...moves.filter((m) => m.account !== null && m.player !== null && m.delta < 0n && !m.refund && inRange(m.ts))
      .map((m) => ({ player: m.player!, amount: -m.delta, paidIn: { id: m.id, account: m.account!, from: m.ts, to: m.ts } })),
    ...result.appeared.flatMap((g) => (g.owner ? [{ player: g.owner.uuid, amount: g.amount, paidIn: { id: null, account: g.account, from: g.from, to: g.to } }] : [])),
  ].sort((a, b) => a.paidIn.from - b.paidIn.from);
  const used = new Set<number>(), found: NoteMatch[] = [];
  for (const d of ins) {
    const fits = outs.filter((w) => !used.has(w.id!) && w.player !== d.player && w.ts < d.paidIn.to && d.paidIn.from - w.ts <= DAY);
    const one = fits.findLast((w) => w.delta === d.amount);
    let pick = one ? [one] : null;
    // ponytail: runs start at each withdrawal of a player, newest first: O(window x RUN), fine for a day of withdrawals.
    for (let i = fits.length - 1; !pick && i >= 0; i--) {
      const mine = fits.slice(0, i + 1).filter((w) => w.player === fits[i]!.player).slice(-RUN).reverse();
      let sum = 0n;
      for (let k = 0; k < mine.length && sum < d.amount; k++) if ((sum += mine[k]!.delta) === d.amount && k > 0) pick = mine.slice(0, k + 1).reverse();
    }
    if (!pick) continue;
    for (const w of pick) used.add(w.id!);
    found.push({ out: pick[0]!.player!, in: d.player, amount: d.amount, withdrawn: pick.map((w) => ({ id: w.id!, account: w.account!, ts: w.ts })), paidIn: d.paidIn });
  }
  return found;
}

export function links(uuid: string, scope: Scope): PlayerLink[] {
  const db = mainData();
  if (!db) return [];
  const nameOf = names(db);
  const found = new Map<string, PlayerLink>();
  const link = (other: string) => found.get(other) ?? found.set(other, { player: { uuid: other, name: nameOf(other) }, strength: 'weak', ways: [], records: { ledger: [], orders: [] } }).get(other)!;

  // Proven: one account, both its users. The owner of an account counts as one of its users.
  const people = new Map<number, { name: string; users: Set<string> }>();
  for (const r of all(db, `SELECT number, name, owner AS uuid FROM account WHERE owner IS NOT NULL
      UNION SELECT a.number, a.name, u.uuid FROM account_user u JOIN account a ON a.number = u.account`)) {
    const n = num(r.number)!;
    (people.get(n) ?? people.set(n, { name: String(r.name), users: new Set() }).get(n)!).users.add(String(r.uuid));
  }
  for (const [account, a] of people) {
    if (a.users.has(uuid)) for (const other of a.users) if (other !== uuid) link(other).ways.push({ kind: 'account', account, name: a.name });
  }

  // Proven: transfers between an account each owns. The current mods log one row on each side, the same time and amount.
  const owner = new Map(all(db, 'SELECT number, owner FROM account WHERE owner IS NOT NULL').map((r) => [num(r.number)!, String(r.owner)]));
  const own = [...owner].filter(([, o]) => o === uuid).map(([n]) => n);
  const params: Record<string, SQLInputValue> = { own: JSON.stringify(own) };
  if (scope.from !== null) params.from = scope.from;
  if (scope.to !== null) params.to = scope.to;
  const sums = new Map<string, Extract<LinkWay, { kind: 'transfer' }>>(), seen = new Set<string>();
  for (const r of all(db, `SELECT id, ts, account, other_account, kind, amount, note, balance_after FROM ledger
      WHERE kind IN (${TRANSFER.map((k) => `'${k}'`).join(', ')}) AND other_account IS NOT NULL
      AND (account IN (SELECT value FROM json_each(:own)) OR other_account IN (SELECT value FROM json_each(:own)))
      ${scope.from !== null ? 'AND ts >= :from' : ''} ${scope.to !== null ? 'AND ts <= :to' : ''} ${onServer(scope, params)} ORDER BY ts, id`, params)) {
    const account = num(r.account)!, other = num(r.other_account)!, mine = owner.get(account) === uuid;
    const them = owner.get(mine ? other : account);
    const d = change(String(r.kind), big(r.amount)!, text(r.note), big(r.balance_after));
    if (!them || them === uuid || d === null) continue;
    const l = link(them);
    l.records.ledger.push(num(r.id)!);
    const amount = d < 0n ? -d : d, key = `${num(r.ts)}|${amount}|${Math.min(account, other)}|${Math.max(account, other)}`;
    if (seen.has(key)) continue; // the other side of a transfer already counted
    seen.add(key);
    const t = sums.get(them) ?? sums.set(them, { kind: 'transfer', sent: 0n, received: 0n, transfers: 0 }).get(them)!;
    t.transfers++;
    if ((d < 0n) === mine) t.sent += amount; else t.received += amount;
  }
  for (const [them, t] of sums) link(them).ways.push(t);
  for (const l of found.values()) l.strength = 'proven';

  // Likely: notes.
  for (const m of noteMatches(scope)) {
    if (m.out !== uuid && m.in !== uuid) continue;
    const l = link(m.out === uuid ? m.in : m.out);
    l.ways.push({ kind: 'notes', amount: m.amount, tookOut: m.out === uuid, withdrawn: m.withdrawn.map((w) => ({ account: w.account, ts: w.ts })),
      paidIn: { account: m.paidIn.account, from: m.paidIn.from, to: m.paidIn.to, logged: m.paidIn.id !== null } });
    l.records.ledger.push(...m.withdrawn.map((w) => w.id), ...(m.paidIn.id === null ? [] : [m.paidIn.id]));
    if (l.strength === 'weak') l.strength = 'likely';
  }

  // Weak: the same market in trading sessions that overlap (in the range).
  // ponytail: every session of the player against every other session, fine for the thousands of a real copy.
  const byPlayer = new Map<string, OrderRow[]>();
  for (const o of readOrders(db, {}, scope.to)) byPlayer.get(o.player)?.push(o) ?? byPlayer.set(o.player, [o]);
  const sessionsOf = (list: OrderRow[]) => split(list, scope.server).filter((s) => (scope.from === null || s.end >= scope.from) && (scope.to === null || s.start <= scope.to));
  const mine = sessionsOf(byPlayer.get(uuid) ?? []);
  const ordersIn = (list: OrderRow[], item: number, from: number, to: number) =>
    list.filter((o) => o.item === item && o.time >= from && o.time <= to && (scope.server === null || o.server === scope.server)).map((o) => o.orderId ?? o.id);
  const weak: { other: string; total: number; ways: (Extract<LinkWay, { kind: 'market' }> & { orders: Set<number> })[] }[] = [];
  for (const [other, list] of byPlayer) {
    if (other === uuid || !mine.length) continue;
    const markets = new Map<number, Extract<LinkWay, { kind: 'market' }> & { orders: Set<number> }>();
    for (const t of sessionsOf(list)) for (const s of mine) {
      const lo = Math.max(s.start, t.start), hi = Math.min(s.end, t.end);
      if (lo > hi) continue;
      for (const item of s.markets) {
        if (!t.markets.includes(item)) continue;
        const m = markets.get(item) ?? markets.set(item, { kind: 'market', item, overlapMs: 0, sessions: 0, orders: new Set() }).get(item)!;
        m.overlapMs += hi - lo;
        m.sessions++;
        // The records: each one's orders on the market during the overlap and up to 5 minutes (a session's gap) around it.
        const near = (u: { start: number; end: number }) => [Math.max(u.start, lo - NEAR), Math.min(u.end, hi + NEAR)] as const;
        for (const id of [...ordersIn(byPlayer.get(uuid)!, item, ...near(s)), ...ordersIn(list, item, ...near(t))]) m.orders.add(id);
      }
    }
    if (markets.size) {
      const ways = [...markets.values()].sort((a, b) => b.overlapMs - a.overlapMs || b.sessions - a.sessions).slice(0, MARKETS);
      weak.push({ other, total: ways.reduce((s, w) => s + w.overlapMs, 0), ways });
    }
  }
  weak.sort((a, b) => b.total - a.total || b.ways.length - a.ways.length);
  let alone = 0;
  for (const w of weak) {
    if (!found.has(w.other) && ++alone > WEAK_PLAYERS) continue;
    const l = link(w.other);
    for (const { orders, ...way } of w.ways) {
      l.ways.push(way);
      l.records.orders.push(...orders);
    }
  }

  return [...found.values()].sort((a, b) => RANK[a.strength] - RANK[b.strength] || b.ways.length - a.ways.length || (a.player.name < b.player.name ? -1 : 1));
}

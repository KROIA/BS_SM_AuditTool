// The bank's money over time, move by move, for the timeline of the money flow (AT-59). Every log entry of a money item
// becomes a move between two places, the changes between two snapshots that no entry explains become moves from or to
// "unexplained", and notes paid in at the exact amount someone took out at most a day before become one move from
// account to account through the world: money carried as notes from one account to another, an estimate.
import type { FlowTimeline, Place, RuleSettings, Scope, TimelineMove } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { countNotes, noteChange, type NoteMove } from './banknotes.ts';
import { checkAll, moneyItems, read, unpaired } from './check.ts';
import { names } from './db.ts';

const DAY = 86_400_000;
const TRANSFER = new Set(['TRANSFER', 'TRANSFER_IN', 'TRANSFER_OUT']);
const abs = (v: bigint) => (v < 0n ? -v : v);
/** Money coming into an account from another place, or leaving it for one. */
const ends = (account: number, inn: boolean, other: Place) => (inn ? { from: other, to: account } : { from: account, to: other });

export function flowTimeline(scope: Scope, settings: RuleSettings): FlowTimeline {
  const db = mainData();
  if (!db) return { reason: 'No save with bank data is loaded, so no money can be followed.', moves: [], players: [], unknown: 0 };
  const money = moneyItems(db), { snaps, moves: byKey } = read(db, null);
  const inRange = (t: number) => (scope.from === null || t >= scope.from) && (scope.to === null || t <= scope.to);
  const out: TimelineMove[] = [];
  const add = (m: Pick<TimelineMove, 'time' | 'from' | 'to' | 'amount' | 'kind'> & Partial<TimelineMove>) => {
    out.push({ until: null, basis: 'proven', by: null, paidInBy: null, rows: [], orders: [], ...m });
    return out.at(-1)!;
  };
  let unknown = 0;
  const transfers = new Map<string, TimelineMove>(); // one transfer writes a row on each side: both go into one move

  for (const [key, list] of byKey) {
    const [account, item] = key.split(':').map(Number) as [number, number];
    if (!money.has(item)) continue;
    // RAW_CHANGE rows that log a trade a second time are paired away per snapshot interval, as the check does.
    const cuts = [...(snaps.get(key) ?? []).map(([ms]) => ms), Infinity];
    let k = 0;
    for (const cut of cuts) {
      let trades = 0n, raw = 0n, last = 0;
      const ids: number[] = [];
      for (; k < list.length && list[k]!.ts <= cut; k++) {
        const m = list[k]!;
        if (m.how === 'trade') trades += m.amount;
        if (m.how !== 'raw') continue;
        raw += m.amount;
        last = m.ts;
        ids.push(m.id);
      }
      const left = unpaired(trades, raw);
      if (left) add({ time: last, ...ends(account, left > 0n, 'other'), amount: abs(left), kind: 'other', rows: ids });
    }
    for (const m of list) {
      if (m.how === 'unknown') { if (inRange(m.ts)) unknown++; continue; }
      if (m.how === 'raw' || m.amount === 0n) continue;
      const inn = m.amount > 0n, amount = abs(m.amount);
      if (m.how === 'trade') { add({ time: m.ts, ...ends(account, inn, 'markets'), amount, kind: 'trade', [m.order ? 'orders' : 'rows']: [m.id] }); continue; }
      if (noteChange(m.kind, m.amount, m.note, null)) continue; // notes come from the note count below, which knows who moved them
      if (TRANSFER.has(m.kind) && m.other !== null) {
        const e = ends(account, inn, m.other), id = `${e.from}>${e.to}:${amount}@${m.ts}`, seen = transfers.get(id);
        if (seen) seen.rows.push(m.id);
        else transfers.set(id, add({ time: m.ts, ...e, amount, kind: 'transfer', rows: [m.id] }));
        continue;
      }
      const kind = m.kind.startsWith('ADMIN_') ? 'admin' : 'other';
      add({ time: m.ts, ...ends(account, inn, kind), amount, kind, rows: [m.id] });
    }
  }

  // Notes: the log's own rows (NoteFlow rows name no account). A deposit takes the latest withdrawal of the same amount
  // within the day before it that is not taken yet, the same player's first. A refund only undoes a withdrawal.
  // ponytail: one withdrawal per deposit; a deposit made of several withdrawals stays two moves through the world.
  const notes = countNotes({ from: null, to: scope.to, server: null }).moves.filter((n) => n.id !== null && n.account !== null && n.delta !== 0n);
  const outs = new Map<bigint, NoteMove[]>(), used = new Set<NoteMove>(), matched = new Map<NoteMove, NoteMove>();
  for (const n of notes) if (n.delta > 0n) (outs.get(n.delta) ?? outs.set(n.delta, []).get(n.delta)!).push(n); // withdrawals by amount
  for (const d of notes) {
    if (d.delta > 0n || d.refund) continue;
    const fits = (outs.get(-d.delta) ?? []).filter((w) => !used.has(w) && w.ts <= d.ts && d.ts - w.ts <= DAY);
    const w = fits.findLast((x) => x.player !== null && x.player === d.player) ?? fits.at(-1);
    if (!w) continue;
    used.add(w);
    matched.set(d, w);
  }
  for (const n of notes) {
    const w = matched.get(n);
    if (w) add({ time: w.ts, until: n.ts, from: w.account!, to: n.account!, amount: w.delta, kind: 'notes', basis: 'estimate', by: w.player, paidInBy: n.player, rows: [w.id!, n.id!] });
    else if (n.delta > 0n && !used.has(n)) add({ time: n.ts, from: n.account!, to: 'world', amount: n.delta, kind: 'notes', by: n.player, rows: [n.id!] });
    else if (n.delta < 0n) add({ time: n.ts, from: 'world', to: n.account!, amount: -n.delta, kind: 'notes', paidInBy: n.player, rows: [n.id!] });
  }

  for (const [account, items] of checkAll(null, scope, settings)) {
    for (const c of items) {
      if (!money.has(c.item)) continue;
      for (const g of c.gaps) add({ time: g.to, ...ends(account, g.difference > 0n, 'unexplained'), amount: abs(g.difference), kind: 'unexplained', basis: 'estimate' });
    }
  }

  const moves = out.filter((m) => inRange(m.time) || (m.until !== null && inRange(m.until))).sort((a, b) => a.time - b.time);
  const nameOf = names(db), who = new Set(moves.flatMap((m) => [m.by, m.paidInBy]).filter((u) => u !== null));
  return { reason: null, moves, players: [...who].map((uuid) => ({ uuid, name: nameOf(uuid) })), unknown };
}

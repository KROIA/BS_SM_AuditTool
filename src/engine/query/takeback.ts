// What to take back (DESIGN_SPEC 8.10): per personal account of an incident's players, from a cutoff to the copy. The money
// comes from the money flow run from the cutoff (flow.ts), the items from the trades on the account since its snapshot.
import type { Cutoff, RuleSettings, Scope, TakeBack, TakeBackItem } from '../../shared/api.ts';
import type { DatabaseSync } from 'node:sqlite';
import { mainData, mainSave } from '../workspace.ts';
import { moneyItems, read } from './check.ts';
import { all, big } from './db.ts';
import { moneyFlow } from './flow.ts';
import { incidents } from './incidents.ts';
import { noteMatches } from './links.ts';

const ALL: Scope = { from: null, to: null, server: null };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** What a player outside the incident gives back: the incident's notes they likely paid in plus their net gain on its markets, at most what is there. */
export const viaTakeOf = (now: bigint, notes: bigint, gain: bigint) => min(now, notes + (gain > 0n ? gain : 0n));
const ZERO = { outside: 0n, inFiles: 0n, elsewhere: 0n, notFound: 0n, others: [] };

/** What an incident player may keep: the balance at the cutoff plus what trading outside the incident earned since, at most what is there. */
export const keepOf = (now: bigint, start: bigint, other: bigint) => min(now, start + (other > 0n ? other : 0n));
/** Items to remove: what was bought since the cutoff, at most what was added since; the player's own deposits stay. */
export const removeOf = (bought: bigint, now: bigint, before: bigint) => {
  const r = min(bought, now - before);
  return r > 0n ? r : 0n;
};

/** The end of the day before t, in this computer's time zone (the one the screens show): the last millisecond of it. */
export function dayBefore(t: number) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - 1;
}

/** Per item the account traded since the cutoff: held at the cutoff, net bought, money spent, held now, to remove. */
function itemsOf(db: DatabaseSync, account: number, at: number): TakeBackItem[] {
  const { snaps, moves } = read(db, account);
  const money = [...moneyItems(db)];
  const held = new Map(all(db, 'SELECT item, balance + locked AS v FROM balance WHERE account = :account', { account }).map((r) => [Number(r.item), big(r.v)!]));
  const out: TakeBackItem[] = [];
  for (const [key, list] of moves) {
    const item = Number(key.split(':')[1]);
    if (money.includes(item)) continue;
    // As the money flow: from the newest snapshot at or before the cutoff. An item without one held nothing then.
    const s = snaps.get(key) ?? [];
    const k = s.findLastIndex(([t]) => t <= at);
    const [since, before] = k < 0 ? [at, 0n] : s[k]!;
    let bought = 0n, spent = 0n;
    for (const m of list) if (m.how === 'trade' && m.ts > since) bought += m.amount;
    if (bought <= 0n) continue;
    for (const mi of money) for (const m of moves.get(`${account}:${mi}`) ?? []) if (m.how === 'trade' && m.market === item && m.ts > since) spent -= m.amount;
    const now = held.get(item) ?? s.at(-1)?.[1] ?? before;
    const remove = removeOf(bought, now, before);
    if (remove > 0n) out.push({ item, before, bought, spent, now, remove });
  }
  return out.sort((a, b) => (b.spent > a.spent ? 1 : b.spent < a.spent ? -1 : a.item - b.item));
}

export function takeBack(incidentId: string, cutoff: Cutoff, settings: RuleSettings): TakeBack {
  const db = mainData(), main = mainSave();
  const legacy = main?.generation === 'legacy';
  const inc = db ? incidents(ALL, settings).incidents.find((i) => i.id === incidentId) ?? null : null;
  const day = inc ? dayBefore(inc.start) : 0, first = inc ? inc.start - 1 : 0;
  const at = cutoff.kind === 'custom' && cutoff.at !== null ? cutoff.at : cutoff.kind === 'first' ? first : day;
  const empty = (reason: string): TakeBack => ({ reason, incident: inc, at, day, first, rows: [], items: 0n, notes: ZERO, to: main?.lastPlayedMs ?? null, legacy, missing: [] });
  if (!db || !main) return empty('No save with bank data is loaded, so there is nothing to take back.');
  if (!inc) return empty('This incident is not raised with the current rule settings.');

  // Players outside the incident who likely paid in notes its players took out after the cutoff (DESIGN_SPEC 8.9).
  const own = new Set(inc.players.map((p) => p.uuid)), via = new Map<string, { out: string; notes: bigint }>();
  for (const m of noteMatches(ALL)) {
    if (!own.has(m.out) || own.has(m.in) || m.withdrawn[0]!.ts <= at || m.paidIn.to <= at) continue;
    const v = via.get(m.in) ?? { out: m.out, notes: 0n };
    via.set(m.in, { ...v, notes: v.notes + m.amount });
  }
  const f = moneyFlow(ALL, incidentId, null, settings, { start: at, players: [...via.keys()], split: true });
  if (f.reason !== null) return empty(f.reason);
  const who = (uuid: string) => f.players.find((p) => p.uuid === uuid) ?? { uuid, name: uuid.slice(0, 8) };

  const rows = f.accounts.map((a) => {
    const parts = f.parts.filter((p) => p.accounts[0] === a.account);
    const net = (incident: boolean) => parts.reduce((s, p) => (p.market === null || p.incident !== incident ? s : p.kind === 'market' ? s + p.amount : s - p.amount), 0n);
    const other = net(false), v = via.get(a.player);
    // A player outside the incident is here for the notes they likely paid in: they give back only what traces to the
    // incident (those notes and their gain on its markets); the rest of their account (removals, goods) is not its.
    const keep = v ? a.now - viaTakeOf(a.now, v.notes, net(true)) : keepOf(a.now, a.start, other);
    const removed = parts.filter((p) => p.kind === 'removed' && p.gap).map((p) => ({ key: `${a.account}@${p.gap!.from}`, amount: p.amount, ...p.gap! }));
    return { account: a.account, player: who(a.player), via: v ? { ...who(v.out), notes: v.notes } : null, from: a.from, start: a.start, now: a.now, other, keep, take: a.now - keep,
      removed: v ? [] : removed, items: v ? [] : itemsOf(db, a.account, at) };
  });
  rows.sort((x, y) => Number(x.via !== null) - Number(y.via !== null)); // the incident's own players first
  const items = f.parts.filter((p) => p.kind === 'items' && own.has(p.player)).reduce((s, p) => s + p.amount, 0n);
  return { reason: null, incident: inc, at, day, first, rows, items, notes: f.notes, to: f.to, legacy, missing: f.missing };
}

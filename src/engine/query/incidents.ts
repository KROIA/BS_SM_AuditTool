// Incidents (DESIGN_SPEC 8.5) and the suspicion order of the players (8.3), both made from the findings.
import type { Finding, Incident, IncidentsResult, Level, RuleSettings, Scope } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { findings, RANK, shown, state } from './findings.ts';
import { sales, type Sale } from './sessions.ts';

/** Findings (and incidents) less than this apart join when they share a player or a market. */
const JOIN = 30 * 60_000;
const ALL: Scope = { from: null, to: null, server: null };
/** The players a finding holds to account. A price spike names who traded in that minute but blames none of them. */
const blamed = (f: Finding) => (f.rule === 'price-spike' ? [] : f.players);

interface Group { list: Finding[]; players: Set<string>; markets: Set<number>; start: number; end: number }

/**
 * Findings into groups: two groups join when they share a player or a market and their spans lie less than 30 minutes
 * apart, repeated until nothing joins. A finding's players include the owner of each account it names (owner holds
 * personal accounts only: company and shared accounts give no player). Each group's findings oldest first.
 */
export function join(list: Finding[], owner: Map<number, string>): Group[] {
  const groups: Group[] = [...list].sort((a, b) => a.start - b.start).map((f) => ({
    list: [f], start: f.start, end: f.end, markets: new Set(f.markets),
    players: new Set([...blamed(f).map((p) => p.uuid), ...f.accounts.flatMap((a) => owner.get(a) ?? [])]),
  }));
  const meets = (a: Group, b: Group) => b.start - a.end < JOIN && a.start - b.end < JOIN
    && ([...b.players].some((p) => a.players.has(p)) || [...b.markets].some((m) => a.markets.has(m)));
  // ponytail: pairwise until nothing joins, O(n^2) per pass; fine for hundreds of findings, sweep by time if it gets slow.
  for (let joined = true; joined;) {
    joined = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = groups.length - 1; j > i; j--) {
        const a = groups[i]!, b = groups[j]!;
        if (!meets(a, b)) continue;
        a.list.push(...b.list);
        b.players.forEach((p) => a.players.add(p));
        b.markets.forEach((m) => a.markets.add(m));
        [a.start, a.end] = [Math.min(a.start, b.start), Math.max(a.end, b.end)];
        groups.splice(j, 1);
        joined = true;
      }
    }
  }
  for (const g of groups) g.list.sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1));
  return groups;
}

const union = <T extends number | string>(v: T[]) => [...new Set(v)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export function incidents(scope: Scope, settings: RuleSettings): IncidentsResult {
  const db = mainData();
  if (!db) return { incidents: [], others: [] };
  const st = state(db);
  const sold = new Map<string, Sale[]>();
  const salesOf = (p: string) => sold.get(p) ?? sold.set(p, sales(st.byPlayer.get(p) ?? [])).get(p)!;
  const alone = new Set<Finding>();
  const out: Incident[] = [];
  for (const g of join(findings(ALL, settings).findings, st.owner)) {
    if (g.list.length === 1) {
      alone.add(g.list[0]!);
      continue;
    }
    let profit = 0n;
    for (const p of g.players) {
      for (const s of salesOf(p)) if (g.markets.has(s.order.item) && s.order.time >= g.start && s.order.time <= g.end) profit += s.profit;
    }
    const i: Incident = {
      id: g.list[0]!.id, level: g.list.reduce<Level>((l, f) => (RANK[f.level] < RANK[l] ? f.level : l), 'low'), start: g.start, end: g.end,
      players: [...g.players].map((uuid) => ({ uuid, name: st.nameOf(uuid) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      markets: union([...g.markets]), accounts: union(g.list.flatMap((f) => f.accounts)), servers: union(g.list.flatMap((f) => f.servers)),
      findings: g.list.map((f) => f.id), profit,
    };
    if (shown(i, scope)) out.push(i);
  }
  out.sort((a, b) => RANK[a.level] - RANK[b.level] || (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : 0) || a.start - b.start);
  return { incidents: out, others: findings(scope, settings).findings.filter((f) => alone.has(f)) };
}

const WEIGHT: Record<Level, number> = { critical: 8, high: 4, medium: 2, low: 1 };

/** Each player's place in the suspicion order (DESIGN_SPEC 8.3): 8, 4, 2, 1 per open finding by its level. Dismissed findings and price spikes do not count. */
export function suspicion(list: Finding[], dismissed: ReadonlySet<string> = new Set()): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of list) if (!dismissed.has(f.id)) for (const p of blamed(f)) out.set(p.uuid, (out.get(p.uuid) ?? 0) + WEIGHT[f.level]);
  return out;
}

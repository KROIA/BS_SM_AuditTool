// Incidents, made from the findings. The suspicion order of the players is in shared/incident.ts.
import type { Finding, Incident, IncidentsResult, Level, RuleSettings, Scope } from '../../shared/api.ts';
import { blamed } from '../../shared/incident.ts';
import { caseData, mainData, within } from '../workspace.ts';
import { findings, RANK, shown, state } from './findings.ts';
import { sales, type Sale } from './sessions.ts';

/** Findings (and incidents) less than this apart join when they share a player or a market. */
const JOIN = 30 * 60_000;
const ALL: Scope = { from: null, to: null, server: null };

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

/** Made from the findings of all the data; an incident's focus only picks which are shown. */
export const incidents = (scope: Scope, settings: RuleSettings): IncidentsResult => within(null, () => incidentsOf(scope, settings));
function incidentsOf(scope: Scope, settings: RuleSettings): IncidentsResult {
  const db = mainData();
  const marked = Object.keys(caseData().marks);
  if (!db) return { incidents: [], others: [], orphans: marked };
  const st = state(db);
  const every = findings(ALL, settings).findings, raised = new Set(every.map((f) => f.id));
  const sold = new Map<string, Sale[]>();
  const salesOf = (p: string) => sold.get(p) ?? sold.set(p, sales(st.byPlayer.get(p) ?? [])).get(p)!;
  const alone = new Set<Finding>();
  const out: Incident[] = [];
  for (const g of join(every, st.owner)) {
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
  return { incidents: out, others: findings(scope, settings).findings.filter((f) => alone.has(f)), orphans: marked.filter((id) => !raised.has(id)) };
}

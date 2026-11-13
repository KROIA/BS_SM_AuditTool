// An incident's title and its sentence for the Overview, in plain English from its figures (DESIGN_SPEC 6.1 and 8.5),
// and the suspicion order of the players (8.3). Shared by the screens and the report. itemName turns an item id into its name ("Diamond").
import type { Finding, Incident, Level } from './api.ts';
import { count, moneyShort, time } from './fmt.ts';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Two names in full, more as a count. null when the incident has none. */
function who(i: Incident): string | null {
  const n = i.players.length;
  return n === 0 ? null : n <= 2 ? i.players.map((p) => p.name).join(' and ') : plural(n, 'player');
}
function where(i: Incident, itemName: (id: number) => string): string | null {
  const names = i.markets.map((m) => itemName(m).toLowerCase());
  return names.length === 0 ? null : names.length === 1 ? `the ${names[0]} market` : names.length === 2 ? `the ${names.join(' and ')} markets` : plural(names.length, 'market');
}
/** "within 40 minutes on 4 Nov 2026", or "between 3 Nov 2026 and 5 Nov 2026" over more than one day. In the computer's time zone. */
function when(i: Incident): string {
  const day = (ms: number) => time(ms).split(',')[0]!;
  if (day(i.start) !== day(i.end)) return `between ${day(i.start)} and ${day(i.end)}`;
  const ms = i.end - i.start;
  const length = ms < 2 * HOUR ? plural(Math.max(1, Math.round(ms / MIN)), 'minute') : ms < 2 * DAY ? plural(Math.round(ms / HOUR), 'hour') : plural(Math.round(ms / DAY), 'day');
  return `within ${length} on ${day(i.start)}`;
}

/** The players a finding holds to account. A price spike names who traded in that minute but blames none of them. */
export const blamed = (f: Finding) => (f.rule === 'price-spike' ? [] : f.players);

const WEIGHT: Record<Level, number> = { critical: 8, high: 4, medium: 2, low: 1 };
/** Each player's place in the suspicion order (DESIGN_SPEC 8.3): 8, 4, 2, 1 per open finding by its level. Dismissed findings and price spikes do not count. */
export function suspicion(list: Finding[], dismissed: (id: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of list) if (!dismissed(f.id)) for (const p of blamed(f)) out.set(p.uuid, (out.get(p.uuid) ?? 0) + WEIGHT[f.level]);
  return out;
}

/** An incident still open: at least one of its findings is not marked as "not a problem". */
export const isOpen = (i: Incident, dismissed: (id: string) => boolean) => i.findings.some((id) => !dismissed(id));
/** "The incident" of the range menu and the Overview: the strongest open one (incidents() sorts strongest first). */
export const strongest = (list: Incident[], dismissed: (id: string) => boolean) => list.find((i) => isOpen(i, dismissed)) ?? null;

/** Short: "Tavrik and Quenby on the diamond market". */
export function incidentTitle(i: Incident, itemName: (id: number) => string): string {
  const w = who(i), m = where(i, itemName);
  return upper(w && m ? `${w} on ${m}` : (w ?? m ?? plural(i.findings.length, 'finding')));
}

/** One or two sentences: who made or lost how much where and when, then how many findings and the strongest level. */
export function incidentSentence(i: Incident, itemName: (id: number) => string): string {
  const w = who(i), m = where(i, itemName), n = plural(i.findings.length, 'finding');
  if (w && m && i.profit !== 0n) {
    return `${upper(w)} ${i.profit > 0n ? 'made' : 'lost'} ${moneyShort(i.profit < 0n ? -i.profit : i.profit)} on ${m} ${when(i)}. `
      + `The incident holds ${n}, the strongest of them ${i.level}.`;
  }
  return `${upper(`${n} about ${[w, m].filter((x) => x !== null).join(' on ')}`)} ${when(i)}. The strongest of them is ${i.level}.`;
}

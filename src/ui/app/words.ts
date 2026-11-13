// Items, bank log rows and gaps in plain words, for every screen that shows them.
import type { Gap, ItemCheck, ItemRow, LedgerRow, Level } from '../../shared/api.ts';
import { KIND, plainName, span } from '../../shared/finding.ts';
import { at, count, items as quantity, money } from '../../shared/fmt.ts';

export const tone = (raw: bigint) => (raw > 0n ? 'var(--up)' : raw < 0n ? 'var(--down)' : 'var(--text)');
/** A level's colour; a gap's rating (low, medium, high) uses the same. */
export const LEVEL_COLOR: Record<Level, string> = { critical: 'var(--crit)', high: 'var(--high)', medium: 'var(--med)', low: 'var(--low)' };

/** A gap of the check per account (DESIGN_SPEC 8.4) as an entry of a history, at the snapshot that showed it. */
export interface GapRow { id: string; time: number; account: number; item: number; gap: Gap }
export const gapRows = (account: number, checks: ItemCheck[]): GapRow[] =>
  checks.flatMap((c) => c.gaps.map((gap) => ({ id: `gap:${account}:${c.item}:${gap.to}`, time: gap.to, account, item: c.item, gap })));
/** Log rows and gaps together, newest first. */
export type Entry = { time: number; row: LedgerRow; gap?: undefined } | { time: number; gap: GapRow; row?: undefined };
export const entries = (rows: LedgerRow[], gaps: GapRow[]): Entry[] =>
  [...gaps.map((gap) => ({ time: gap.time, gap })), ...rows.map((row) => ({ time: row.time, row }))].sort((a, b) => b.time - a.time);

/** Where a bank log row was made: "on mining-1 · at the overworld, -230 70 -920". Empty when the log does not say (BS-256, BS-258). */
export function whereMade(r: LedgerRow, master: string | undefined): string {
  const p = r.place;
  // Only a slave is named: most rows are the master's, and naming it on each one is noise.
  return [r.server === null || r.server === master ? '' : `on ${r.server}`, p ? at(p.dimension, p.x, p.y, p.z) : ''].filter(Boolean).join(' · ');
}

/** The words for the items of the loaded save. */
export function words(itemRows: Map<number, ItemRow>) {
  /** "minecraft:iron_ingot" -> "Iron ingot" */
  function itemName(id: number): string {
    const name = itemRows.get(id)?.name;
    return name ? plainName(name) : 'Item ' + id;
  }
  const isMoney = (id: number) => itemRows.get(id)?.money ?? false;
  /** A balance or a change of any item: money as money, other items as a count with their name. */
  const value = (item: number, raw: bigint) => (isMoney(item) ? money(raw) : quantity(raw) + ' ' + itemName(item));
  const change = (item: number, raw: bigint) => (raw > 0n ? '+' : '') + value(item, raw);
  return {
    itemName, isMoney, value, change,
    what: (r: LedgerRow) =>
      r.kind === 'TRADE_BUY' || r.kind === 'TRADE_SELL'
        ? `${r.kind === 'TRADE_BUY' ? 'Bought' : 'Sold'} ${quantity(r.amount < 0n ? -r.amount : r.amount)} ${itemName(r.item)}`
        : (KIND[r.kind] ?? r.kind),
    /** A row's amount: the money side of a trade, else its change; the stored amount, unsigned, when the direction is unknown. */
    amount: (r: LedgerRow) => (r.money ? change(r.money.item, r.money.change) : r.change === null ? value(r.item, r.amount) : change(r.item, r.change)),
    amountTone: (r: LedgerRow) => {
      const v = r.money?.change ?? r.change;
      return v === null ? 'var(--text3)' : tone(v);
    },
    gapWhat: (g: GapRow) => `${isMoney(g.item) ? 'Balance' : itemName(g.item)} ${g.gap.difference > 0n ? 'rose' : 'fell'} with no log entry`,
    gapSub: (g: GapRow) => 'Seen between two balance snapshots'
      + (g.gap.labels.length ? `; the log has entries without a direction in that time: ${g.gap.labels.map((k) => (KIND[k] ?? k).toLowerCase()).join(', ')}` : ''),
    /** When a gap happened: between its two snapshots. */
    gapWhen: (g: GapRow) => span(g.gap.from, g.gap.to),
  };
}

export { plainName };
/** Stacks found in the world (player files, region scan): value is raw money for the whole stack, null for a valuable. */
interface Held { path: string[]; item: string; count: number; value: bigint | null }
/** "1'408 notes of $1'000'000.00, 30 notes of $1.00, also 64 Diamond, partly in a shulker box" */
export function heldText(stacks: Held[]): string {
  const notes = new Map<bigint, number>(), things = new Map<string, number>(), boxes = new Set<string>();
  for (const s of stacks) {
    if (s.value !== null && s.count > 0) { const each = s.value / BigInt(s.count); notes.set(each, (notes.get(each) ?? 0) + s.count); }
    else if (s.value === null) things.set(s.item, (things.get(s.item) ?? 0) + s.count);
    if (s.path.length) boxes.add(plainName(s.path.at(-1)!).toLowerCase());
  }
  const parts = [...notes].sort((a, b) => (b[0] > a[0] ? 1 : -1)).map(([each, n]) => `${count(n)} ${n === 1 ? 'note' : 'notes'} of ${money(each)}`);
  // The three largest kinds of valuables, then how many more: a chest of odds and ends would fill the line.
  const kinds = [...things].sort((a, b) => b[1] - a[1]).map(([item, n]) => `${count(n)} ${plainName(item)}`);
  const other = kinds.length > 3 ? `${kinds.slice(0, 3).join(', ')} and ${count(kinds.length - 3)} more ${kinds.length === 4 ? 'kind' : 'kinds'}` : kinds.join(', ');
  if (other) parts.push(parts.length ? 'also ' + other : other);
  if (boxes.size) parts.push(`${stacks.every((s) => s.path.length) ? 'all' : 'partly'} in a ${[...boxes].join(' or ')}`);
  return parts.join(', ');
}

// Items, bank log rows and gaps in plain words, for every screen that shows them.
import type { Gap, ItemCheck, ItemRow, LedgerRow, Level } from '../../shared/api.ts';
import { KIND, span } from '../../shared/finding.ts';
import { items as quantity, money } from '../../shared/fmt.ts';

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

/** The words for the items of the loaded save. */
export function words(itemRows: Map<number, ItemRow>) {
  /** "minecraft:iron_ingot" -> "Iron ingot" */
  function itemName(id: number): string {
    const name = itemRows.get(id)?.name;
    if (!name) return 'Item ' + id;
    const base = name.slice(name.indexOf(':') + 1).replaceAll('_', ' ');
    return base.charAt(0).toUpperCase() + base.slice(1);
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
    /** A row's amount: the money side of a trade, else its change; the stored amount when the direction is unknown. */
    amount: (r: LedgerRow) => (r.money ? change(r.money.item, r.money.change) : r.change === null ? quantity(r.amount) : change(r.item, r.change)),
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

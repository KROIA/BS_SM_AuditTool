// Items, bank log rows and gaps in plain words, for every screen that shows them.
import type { Gap, ItemCheck, ItemRow, LedgerRow, Level, OrderRow } from '../../shared/api.ts';
import type { Table } from '../../shared/csv.ts';
import { KIND, plainName, span } from '../../shared/finding.ts';
import { at, count, items as quantity, money } from '../../shared/fmt.ts';

export const tone = (raw: bigint) => (raw > 0n ? 'var(--up)' : raw < 0n ? 'var(--down)' : 'var(--text)');
/** A level's colour; a gap's rating (low, medium, high) uses the same. */
export const LEVEL_COLOR: Record<Level, string> = { critical: 'var(--crit)', high: 'var(--high)', medium: 'var(--med)', low: 'var(--low)' };

/** A gap of the check per account as an entry of a history, at the snapshot that showed it. */
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
  const what = (r: LedgerRow) =>
    r.kind === 'TRADE_BUY' || r.kind === 'TRADE_SELL'
      ? `${r.kind === 'TRADE_BUY' ? 'Bought' : 'Sold'} ${quantity(r.amount < 0n ? -r.amount : r.amount)} ${itemName(r.item)}`
      : (KIND[r.kind] ?? r.kind);
  const gapWhat = (g: GapRow) => `${isMoney(g.item) ? 'Balance' : itemName(g.item)} ${g.gap.difference > 0n ? 'rose' : 'fell'} with no log entry`;
  const gapSub = (g: GapRow) => 'Seen between two balance snapshots'
    + (g.gap.labels.length ? `; the log has entries without a direction in that time: ${g.gap.labels.map((k) => (KIND[k] ?? k).toLowerCase()).join(', ')}` : '');
  /** Who made a log row, in words. */
  function by(r: LedgerRow): string {
    const who = r.actorName ?? 'not recorded';
    if (r.sourceKind === 'STOCKMARKET') return `StockMarket, for ${who}`;
    if (r.sourceKind === 'ADMIN') return `${who}, as admin`;
    if (r.sourceKind === 'SYSTEM') return `The bank, for ${who}`;
    return who;
  }
  /** A row's sub line after the other account: an admin's change, the note, an unknown direction, where it was made. */
  function detail(r: LedgerRow, master: string | undefined): string {
    const parts: string[] = [];
    if (r.kind === 'ADMIN_SET' && r.change !== null && r.balanceAfter !== null) parts.push(`from ${value(r.item, r.balanceAfter - r.change)} to ${value(r.item, r.balanceAfter)}`);
    else if (r.note) parts.push(r.note);
    if (r.change === null) parts.push('the log does not say in which direction');
    const where = whereMade(r, master);
    if (where) parts.push(where);
    return parts.join(' · ');
  }
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const KIND_OF = { market: 'Market', limit: 'Limit', intermarket: 'Inter-market' };
  return {
    itemName, isMoney, value, change, what, by, detail, gapWhat, gapSub,
    /** A row's amount: the money side of a trade, else its change; the stored amount, unsigned, when the direction is unknown. */
    amount: (r: LedgerRow) => (r.money ? change(r.money.item, r.money.change) : r.change === null ? value(r.item, r.amount) : change(r.item, r.change)),
    amountTone: (r: LedgerRow) => {
      const v = r.money?.change ?? r.change;
      return v === null ? 'var(--text3)' : tone(v);
    },
    /** When a gap happened: between its two snapshots. */
    gapWhen: (g: GapRow) => span(g.gap.from, g.gap.to),
    /** Orders as a CSV table (AT-44): what the order tables show, every field of the row and the ids behind the links. */
    orderTable: (list: OrderRow[], name: (uuid: string) => string): Table => ({
      columns: [['Order id', 'id'], ['Row id', 'id'], ['Placed', 'time'], ['Finished', 'time'], ['Player', 'text'], ['Player uuid', 'id'], ['Account', 'id'],
        ['Market', 'text'], ['Item id', 'id'], ['Side', 'text'], ['Kind', 'text'], ['Limit price', 'money'], ['Quantity', 'quantity'], ['Wanted', 'quantity'],
        ['Status', 'text'], ['Average price', 'money'], ['Value', 'money'], ['Placed on', 'text']],
      rows: list.map((o) => [o.orderId, o.id, o.time || null, o.finishMs, name(o.player), o.player, o.account, itemName(o.item), o.item, o.amount > 0n ? 'Buy' : 'Sell',
        KIND_OF[o.type], o.limitPrice || null, abs(o.amount), o.wanted === null ? null : abs(o.wanted), o.status, o.price, abs(o.money), o.server]),
    }),
    /** Log rows and gaps as a CSV table: money and items in their own columns, so every cell has one unit. */
    ledgerTable: (list: Entry[], master: string | undefined): Table => ({
      columns: [['Time', 'time'], ['Entry id', 'id'], ['Account', 'id'], ['Type', 'text'], ['What', 'text'], ['Money', 'money'], ['Item change', 'quantity'], ['Item', 'text'],
        ['Item id', 'id'], ['Balance after', 'money'], ['Balance after (items)', 'quantity'], ['Other account', 'id'], ['Done by', 'text'], ['Actor uuid', 'id'],
        ['Reference', 'id'], ['Detail', 'text'], ['Server', 'text'], ['Gap from', 'time']],
      rows: list.map(({ row: r, gap: g }) => {
        if (g) {
          const m = isMoney(g.item), d = g.gap.difference;
          return [g.time, null, g.account, 'no log entry', gapWhat(g), m ? d : null, m ? null : d, itemName(g.item), g.item, m ? g.gap.after : null, m ? null : g.gap.after,
            null, 'not recorded', null, null, gapSub(g), null, g.gap.from];
        }
        const m = isMoney(r!.item), v = r!.change ?? r!.amount;
        return [r!.time, r!.id, r!.account, r!.kind, what(r!), r!.money ? r!.money.change : m ? v : null, r!.money || !m ? v : null, itemName(r!.item), r!.item,
          m ? r!.balanceAfter : null, m ? null : r!.balanceAfter, r!.otherAccount, by(r!), r!.actor, r!.ref, detail(r!, master), r!.server, null];
      }),
    }),
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

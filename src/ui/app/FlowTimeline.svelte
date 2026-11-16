<script lang="ts">
  // The money flow over time: one row per account (or per player, whose personal accounts become one row), a line, then
  // one row per market something shown was traded on and one per other place money goes outside the accounts: notes in
  // the world, an admin, other entries, nowhere the log says. An inter-market order's money runs from market to market.
  // Every move is a band from one row to the other at its time, as thick as the square root of the amount. Notes paid
  // into another account at the amount taken out shortly before run through the World row, dashed: an estimate.
  // Moves closer than a few pixels between the same rows are drawn as one; zoom and drag the time as on the other charts.
  // With non-money items (items) a second list picks the items shown, each in its own colour and scale. A trade shows
  // only whole: the money and the goods (two arrows side by side and a diamond on the market's row) when both are on, an
  // inter-market order when both its items are on. The first list picks the players (or accounts); the markets and
  // places get a row when something shown goes there.
  import type { AccountListRow, FlowTimeline, LedgerRow, Place, TimelineMove } from '../../shared/api.ts';
  import { count, countShort, currency, money, moneyShort, time } from '../../shared/fmt.ts';
  import { app, engine, focusSpan } from './state.svelte.ts';
  import { color as hueOf } from './BalanceChart.svelte';
  import FilterList from './FilterList.svelte';
  import type { words } from './words.ts';
  import { pan, timeTicks, wheel, type View } from './zoom.ts';

  let { tl, accounts, byAccount, items = false, w }: { tl: FlowTimeline; accounts: AccountListRow[]; byAccount: boolean; items?: boolean; w: ReturnType<typeof words> } = $props();

  // ---- Items: the money first, then the most moves; the money and the next few shown at first ----
  const SHOWN_ITEMS = 4;
  const itemList = $derived.by(() => {
    const n = new Map<number, number>();
    for (const m of tl.moves) n.set(m.item, (n.get(m.item) ?? 0) + 1);
    return [...n].sort(([a, x], [b, y]) => Number(w.isMoney(b)) - Number(w.isMoney(a)) || y - x).map(([id]) => id);
  });
  let itemsOff = $derived(new Set<string | number>(itemList.slice(SHOWN_ITEMS)));
  const hue = $derived(new Map(itemList.map((id, k) => [id, hueOf(k)])));
  const label = (id: number) => (w.isMoney(id) ? `Money (${currency()})` : w.itemName(id));
  /** Several items on the chart: the colour shows the item instead of the kind of move. */
  const several = $derived(itemList.filter((id) => !itemsOff.has(id)).length > 1);
  const val = (item: number, v: bigint) => w.value(item, v);
  const short = (item: number, v: bigint) => (w.isMoney(item) ? moneyShort(v) : w.value(item, v));

  // ---- Rows ----
  const SPECIAL: Record<Exclude<Place, number>, string> = {
    world: 'World: notes outside the bank', markets: 'Markets', admin: 'Admin', other: 'Other entries', unexplained: 'Not explained',
  };
  const special = (p: Exclude<Place, number>) => (p === 'world' && items ? 'World: outside the bank' : SPECIAL[p]);
  const ORDER: Exclude<Place, number>[] = ['world', 'admin', 'other', 'unexplained'];
  const SHOWN = 8; // account or player rows shown at first, the most money moved first
  const acct = $derived(new Map(accounts.map((a) => [a.number, a])));
  const nameOf = $derived(new Map(tl.players.map((p) => [p.uuid, p.name])));
  /** The row a place is drawn on: a personal account is its owner's row when players are shown, a market has its own. */
  function rowOf(p: Place, market: number | null = null): { id: string; name: string } {
    if (p === 'markets' && market !== null) return { id: `m:${market}`, name: `${w.itemName(market)} market` };
    if (typeof p === 'string') return { id: p, name: special(p) };
    const a = acct.get(p);
    if (!byAccount && a?.owner && !a.company) return { id: `p:${a.owner}`, name: a.ownerName ?? 'A player' };
    return { id: `a:${p}`, name: a ? `Account ${p} · ${a.deleted ? 'deleted' : a.name}` : `Account ${p}` };
  }
  const fromRow = (m: TimelineMove) => rowOf(m.from, m.market), toRow = (m: TimelineMove) => rowOf(m.to, m.onto ?? m.market);
  const isOwn = (id: string) => id.startsWith('a:') || id.startsWith('p:');
  const rows = $derived.by(() => {
    const seen = new Map<string, { id: string; name: string; v: bigint }>();
    for (const m of tl.moves) for (const r of [fromRow(m), toRow(m)]) (seen.get(r.id) ?? seen.set(r.id, { ...r, v: 0n }).get(r.id)!).v += w.isMoney(m.item) ? m.amount : 0n;
    const all = [...seen.values()].sort((a, b) => Number(b.v - a.v));
    return [...all.filter((r) => isOwn(r.id)), ...all.filter((r) => r.id.startsWith('m:')), ...ORDER.flatMap((id) => seen.get(id) ?? [])];
  });
  // Rows switched off; other rows (the switch between players and accounts) start again with the largest few.
  let off = $derived(new Set<string | number>(rows.filter((r) => isOwn(r.id)).slice(SHOWN).map((r) => r.id)));
  /** A trade's side by the row or order both sides share, and the account it is on. */
  const tradeId = (m: TimelineMove) => `${typeof m.from === 'number' ? m.from : m.to}|${m.orders.length ? 'o' + m.orders[0] : 'r' + m.rows[0]}`;
  /** Inter-market orders by their ledger rows: the money's move from market to market. Its goods and the money's rest
   *  back to the account carry the same rows. */
  const byRow = $derived(new Map(tl.moves.filter((m) => m.onto !== null).flatMap((m) => m.rows.map((r) => [r, m] as const))));
  const orderOf = (m: TimelineMove) => (m.kind !== 'trade' ? undefined : m.onto !== null ? m : m.rows.length ? byRow.get(m.rows[0]!) : undefined);
  /** The other side of every other trade: the money side and the goods side, both ways. */
  const partner = $derived.by(() => {
    const out = new Map<TimelineMove, TimelineMove>(), plain = tl.moves.filter((m) => m.kind === 'trade' && !orderOf(m));
    const goods = new Map(plain.filter((m) => m.item === m.market).map((m) => [tradeId(m), m]));
    for (const m of plain) {
      const g = m.item !== m.market ? goods.get(tradeId(m)) : undefined;
      if (g) out.set(m, g).set(g, m);
    }
    return out;
  });
  const on = (item: number | null) => item === null || !itemsOff.has(item);
  /** Only whole trades: an inter-market order with both its items on (and the money for the money's rest), any other
   *  trade with its goods and its money; a side without its other side in the data by its own item. */
  function whole(m: TimelineMove) {
    const o = orderOf(m);
    if (o) return on(o.market) && on(o.onto) && (m === o || on(m.item));
    const p = partner.get(m);
    return on(m.item) && (!p || on(p.item));
  }
  /** What is shown: whole trades and the other moves of the items on, of the players or accounts on. */
  /** Of the players or accounts on: every row it touches that is a player's or account's is switched on. */
  const mine = (m: TimelineMove) => [fromRow(m), toRow(m), ...(m.trader !== null ? [rowOf(m.trader)] : [])].every((r) => !isOwn(r.id) || !off.has(r.id));
  const shown = $derived(tl.moves.filter((m) => whole(m) && mine(m)));
  /** How much of each item the players or accounts on moved in the range, every move counted by its size. */
  const volume = $derived.by(() => {
    const out = new Map<number, bigint>();
    for (const m of tl.moves) if (mine(m)) out.set(m.item, (out.get(m.item) ?? 0n) + (m.amount < 0n ? -m.amount : m.amount));
    return out;
  });
  // The players or accounts on, then the markets and places something shown goes to.
  const used = $derived(new Set(shown.flatMap((m) => [fromRow(m).id, toRow(m).id])));
  const lanes = $derived(rows.filter((r) => (isOwn(r.id) ? !off.has(r.id) : used.has(r.id))));
  /** The accounts and players above the line, the markets and other places below it. */
  const own = $derived(lanes.filter((r) => isOwn(r.id)).length);
  const laneIndex = $derived(new Map(lanes.map((r, i) => [r.id, i])));
  /** The moves shown as lanes; a move within one row only when it ran through the world. A trade with both sides is one
   *  entry: m the money side, goods the other. */
  const moves = $derived.by(() => {
    const out: { m: TimelineMove; a: number; b: number; goods: TimelineMove | null }[] = [];
    for (const m of shown) {
      if (m.item === m.market && partner.has(m)) continue; // drawn with its money side
      const a = laneIndex.get(fromRow(m).id), b = laneIndex.get(toRow(m).id);
      if (a === undefined || b === undefined || (a === b && m.until === null)) continue;
      out.push({ m, a, b, goods: m.item !== m.market ? (partner.get(m) ?? null) : null });
    }
    return out;
  });

  // ---- Time and zoom ----
  const bounds = $derived.by(() => {
    if (!moves.length) return { from: 0, to: 1, minSpan: 1 };
    const lo = moves[0]!.m.time, hi = Math.max(...moves.map((x) => x.m.until ?? x.m.time)), pad = Math.max(30_000, (hi - lo) * 0.03);
    return { from: lo - pad, to: hi + pad, minSpan: 50 }; // the log times are in ms; moves a few ms apart still part
  });
  // Picking rows or items keeps the zoom; new data shows everything again.
  let manual = $derived((void tl, null as View | null));
  const cur = $derived(manual ?? { x0: bounds.from, x1: bounds.to, y0: 0, y1: 1 });

  const LANE = 56, TOP = 28, MAXW = 22;
  let cw = $state(900);
  const H = $derived(TOP + lanes.length * LANE);
  const yOf = (i: number) => TOP + i * LANE + 20;
  const X = (t: number) => ((t - cur.x0) / (cur.x1 - cur.x0)) * cw;

  // ---- Bands: moves between the same rows within a few pixels are one ----
  // A trade with both sides shown keeps the goods side in goods.
  interface Band {
    key: string; list: TimelineMove[]; a: number; b: number; xa: number; xb: number; amount: bigint; item: number; kind: TimelineMove['kind']; carried: boolean; estimate: boolean;
    goods: { item: number; amount: bigint } | null;
  }
  const bands = $derived.by(() => {
    const out = new Map<string, Band>(), cell = (t: number) => Math.floor(X(t) / 6);
    for (const { m, a, b, goods } of moves) {
      const end = m.until ?? m.time;
      if (X(end) < -40 || X(m.time) > cw + 40) continue;
      const key = [a, b, m.kind, m.item, goods?.item ?? '', m.until !== null, cell(m.time), m.until === null ? '' : cell(m.until)].join('|');
      const g = out.get(key) ?? out.set(key, { key, list: [], a, b, xa: X(m.time), xb: X(end), amount: 0n, item: m.item, kind: m.kind, carried: m.until !== null, estimate: false,
        goods: goods && { item: goods.item, amount: 0n } }).get(key)!;
      g.list.push(m);
      g.amount += m.amount;
      g.estimate ||= m.basis === 'estimate';
      if (goods) g.goods!.amount += goods.amount;
    }
    return [...out.values()].sort((p, q) => p.xa - q.xa);
  });
  // Per item, the full width is four times the 90th percentile band, at most the largest: one huge move (a company's
  // opening balance) gets the full width and leaves the others readable instead of flattening them.
  const most = $derived.by(() => {
    const by = new Map<number, bigint[]>(), put = (item: number, v: bigint) => (by.get(item) ?? by.set(item, []).get(item)!).push(v);
    for (const g of bands) {
      put(g.item, g.amount);
      if (g.goods) put(g.goods.item, g.goods.amount);
    }
    return new Map([...by].map(([item, v]) => {
      v.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const p90 = v[Math.floor((v.length - 1) * 0.9)]!, top = v.at(-1)!;
      return [item, top < p90 * 4n ? top : p90 * 4n];
    }));
  });
  const width = (item: number, v: bigint) => Math.min(MAXW, Math.max(2, Math.sqrt(Number(v) / Number(most.get(item) || 1n)) * MAXW));
  const world = $derived(laneIndex.get('world'));
  /** A trade whose money went to the market: bought. Its market row is b, else a. */
  const bought = (g: Band) => g.list[0]!.to === 'markets';
  type Piece = [d: string, cls: '' | 'dash' | 'head'];
  const f = (v: number) => v.toFixed(1);
  /** A straight piece of width wd from (x0, y0) to (x1, y1) whose shaft stops at the base of an arrowhead pointing at (x1, y1). */
  function arrow(x0: number, y0: number, x1: number, y1: number, cls: '' | 'dash', wd: number): Piece[] {
    const hw = Math.max(5, wd / 2 + 3), L = hw * 1.2, dx = Math.sign(x1 - x0), dy = Math.sign(y1 - y0), bx = x1 - dx * L, by = y1 - dy * L;
    const shaft: Piece[] = Math.abs(x1 - x0 + y1 - y0) > L ? [[`M${f(x0)} ${f(y0)}${dx ? `H${f(bx)}` : `V${f(by)}`}`, cls]] : [];
    return [...shaft, [`M${f(bx - dy * hw)} ${f(by - dx * hw)}L${f(bx + dy * hw)} ${f(by + dx * hw)}L${f(x1)} ${f(y1)}Z`, 'head']];
  }
  /** Straight pieces with flat ends, the last one with an arrowhead into the row the money went to. A move is one vertical band at its time. */
  function path(g: Band, wd: number): Piece[] {
    const ya = yOf(g.a), yb = yOf(g.b), h = wd / 2;
    if (!g.carried) return arrow(g.xa, ya, g.xa, yb, '', wd);
    // Down to the world row (the other row when it is off), along it while the notes were out (dashed: matched by the
    // amount), up into the other account. The verticals reach half a width past the row to fill the corners.
    const yv = yOf(world ?? g.b), down: Piece[] = ya === yv ? [] : [[`M${f(g.xa)} ${ya}V${f(yv + Math.sign(yv - ya) * h)}`, '']];
    if (yb === yv) return [...down, ...arrow(g.xa, yv, g.xb, yv, 'dash', wd)];
    return [...down, [`M${f(g.xa)} ${yv}H${f(g.xb)}`, 'dash'], ...arrow(g.xb, yv - Math.sign(yb - yv) * h, g.xb, yb, '', wd)];
  }
  const MARK = 6; // the half width of a trade's diamond
  /** What a band draws: one arrow; a trade with both sides two arrows side by side, the money and the goods in their own colours, stopping at the diamond. */
  function legs(g: Band): { color: string; wd: number; pieces: Piece[] }[] {
    const wd = width(g.item, g.amount), color = several ? hue.get(g.item)! : COLOR[g.kind];
    if (!g.goods) return [{ color, wd, pieces: path(g, wd) }];
    const wg = width(g.goods.item, g.goods.amount), buy = bought(g), ya = yOf(buy ? g.a : g.b), ym = yOf(buy ? g.b : g.a), ys = ym + Math.sign(ya - ym) * (MARK + 1);
    const xm = g.xa - wd / 2 - 1, xg = g.xa + wg / 2 + 1;
    return [
      { color, wd, pieces: buy ? arrow(xm, ya, xm, ys, '', wd) : arrow(xm, ys, xm, ya, '', wd) },
      { color: hue.get(g.goods.item)!, wd: wg, pieces: buy ? arrow(xg, ys, xg, ya, '', wg) : arrow(xg, ya, xg, ys, '', wg) },
    ];
  }
  const diamond = (g: Band) => { const y = yOf(bought(g) ? g.b : g.a); return `M${f(g.xa)} ${f(y - MARK)}L${f(g.xa + MARK)} ${f(y)}L${f(g.xa)} ${f(y + MARK)}L${f(g.xa - MARK)} ${f(y)}Z`; };
  const COLOR: Record<TimelineMove['kind'], string> = { notes: 'var(--high)', trade: 'var(--buy)', transfer: 'var(--accent)', admin: 'var(--crit)', other: 'var(--text3)', unexplained: 'var(--med)' };
  const KIND: Record<TimelineMove['kind'], string> = { notes: 'Notes', trade: 'Trading', transfer: 'Transfer', admin: 'Admin', other: 'Other entries', unexplained: 'Not explained' };
  const dot = (g: Band) => (several ? hue.get(g.item)! : COLOR[g.kind]);
  const marketOf = (g: Band) => `${w.itemName(g.list[0]!.market!)} market`;
  const across = (g: Band) => g.list[0]!.onto !== null;
  const title = (g: Band) => (g.goods ? `${bought(g) ? 'Bought' : 'Sold'} on the ${marketOf(g)}` : across(g) ? 'Inter-market order' : g.carried ? 'Carried as notes' : KIND[g.kind]);
  /** The amount in short: a trade with both sides as the goods for the money. */
  const figure = (g: Band) => (g.goods ? `${val(g.goods.item, g.goods.amount)} for ${moneyShort(g.amount)}` : short(g.item, g.amount));

  // ---- Pointer, keys, selection ----
  let box = $state<HTMLDivElement>();
  let hover = $state<Band | null>(null);
  // The pick is a move, not a band: zooming or resizing groups the moves anew, and the band holding it stays picked.
  let picked = $state<TimelineMove | null>(null);
  const pick = $derived(picked && (bands.find((g) => g.list.includes(picked!)) ?? null));
  let drag: { x: number; moved: boolean } | null = null;
  /** The band under the pointer: within its rows and its time, the nearest. */
  function hit(px: number, py: number): Band | null {
    let best: Band | null = null, d = 14;
    for (const g of bands) {
      const lo = Math.min(yOf(g.a), yOf(g.b), g.carried && world !== undefined ? yOf(world) : Infinity) - 8, hi = Math.max(yOf(g.a), yOf(g.b), g.carried && world !== undefined ? yOf(world) : -Infinity) + 8;
      if (py < lo || py > hi) continue;
      const dx = px < g.xa ? g.xa - px : px > g.xb ? px - g.xb : 0;
      if (dx < d) [best, d] = [g, dx];
    }
    return best;
  }
  const local = (e: MouseEvent) => { const r = box!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  function move(e: PointerEvent) {
    if (drag) {
      if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
      manual = pan(cur, e.clientX - drag.x, 0, cw, H, bounds);
      drag.x = e.clientX;
      return;
    }
    hover = hit(...local(e));
  }
  function key(e: KeyboardEvent) {
    if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); manual = null; return; }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = pick ? bands.indexOf(pick) : -1, next = bands[e.key === 'ArrowRight' ? i + 1 : i < 0 ? bands.length - 1 : i - 1];
    if (next) picked = next.list[0]!;
  }
  $effect(() => {
    const el = box;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      el.focus({ preventScroll: true });
      manual = wheel(cur, { deltaX: e.deltaX, deltaY: e.deltaY, ctrlKey: false, shiftKey: true }, local(e)[0] / cw, 0.5, bounds); // the time only
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', key);
    return () => (el.removeEventListener('wheel', onWheel), el.removeEventListener('keydown', key));
  });

  // ---- Words ----
  const place = (p: Place) => (typeof p === 'number' ? `account ${p}` : special(p).toLowerCase());
  const who = (u: string | null) => (u === null ? 'someone the log does not name' : nameOf.get(u) ?? 'a player');
  const span = (ms: number) => {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? `${count(s)} s` : s < 3600 ? `${count(Math.round(s / 60))} min` : `${count(Math.round(s / 3600))} h`;
  };
  /** One band in a sentence. */
  function says(g: Band): string {
    const m = g.list[0]!, n = g.list.length, many = n > 1 ? `${count(n)} ${g.goods ? 'trades' : 'moves'}, ` : '', v = val(g.item, g.amount);
    if (g.goods) {
      const buy = m.to === 'markets', by = place(buy ? m.from : m.to);
      return `${many}${n > 1 ? by : by[0]!.toUpperCase() + by.slice(1)} ${buy ? 'bought' : 'sold'} ${val(g.goods.item, g.goods.amount)} for ${money(g.amount)} on the ${marketOf(g)}: the money ${buy ? 'went to the market and the items came back' : 'came from the market for the items'}.`;
    }
    if (across(g)) return `${many}${v} from selling ${w.itemName(m.market!)} went straight on to buy ${w.itemName(m.onto!)}: ${n > 1 ? 'inter-market orders' : 'an inter-market order'}, one order selling one item for another.`;
    if (g.carried) {
      const same = g.list.every((x) => x.by !== null && x.by === x.paidInBy);
      return `${many}${v} left ${place(m.from)} as banknotes and the same amount was paid into ${place(m.to)} ${span(m.until! - m.time)} later, by ${same ? `the same player, ${who(m.by)}` : `${who(m.paidInBy)} after ${who(m.by)} took it out`}. Likely the same money, carried through the world.`;
    }
    switch (m.kind) {
      // ponytail: notes of BankSystem money read as an item here on a server whose market trades in another item.
      case 'notes': return !w.isMoney(m.item) ? `${many}${v} ${m.to === 'world' ? `taken out of ${place(m.from)}` : `paid into ${place(m.to)}`} as the item itself.`
        : m.to === 'world'
        ? `${many}${v} taken out of ${place(m.from)} as banknotes by ${who(m.by)}. No deposit of the same amount followed within a day, so where the notes went is not known.`
        : `${many}${v} in banknotes paid into ${place(m.to)} by ${who(m.paidInBy)}. Nobody took the same amount out within the day before: the notes come from an earlier withdrawal, from several, or from outside the bank.`;
      case 'trade': return `${many}${v} ${m.to === 'markets' ? `${w.isMoney(m.item) ? 'spent' : 'sold'} on the ${marketOf(g)} by ${place(m.from)}` : `received from the ${marketOf(g)} by ${place(m.to)}`}.`;
      case 'transfer': return `${many}${v} transferred from ${place(m.from)} to ${place(m.to)}.`;
      case 'admin': return `${many}${v} ${m.to === 'admin' ? `removed from ${place(m.from)}` : `added to ${place(m.to)}`} by an admin.`;
      case 'other': return `${many}${v} ${m.to === 'other' ? `left ${place(m.from)}` : `came into ${place(m.to)}`} through other log entries: payouts, dividends, changes from an unknown source.`;
      default: return `${many}${v} ${m.to === 'unexplained' ? `left ${place(m.from)}` : `came into ${place(m.to)}`} between two balance snapshots, and the log has no entry for it.`;
    }
  }
  const when = (g: Band) => {
    const a = time(g.list[0]!.time), b = time(g.carried ? g.list.at(-1)!.until! : g.list.at(-1)!.time);
    return a === b ? a : `${a} to ${b}`;
  };

  // The answer first: what moved, and what the notes did.
  const lead = $derived.by(() => {
    const every = moves.flatMap((x) => (x.goods ? [x.m, x.goods] : [x.m])), all = every.filter((m) => w.isMoney(m.item)), sum = (l: TimelineMove[]) => l.reduce((s, m) => s + m.amount, 0n);
    if (!every.length) return items ? 'Nothing moved between the rows and items shown in this time range.' : 'No money moved between the rows shown in this time range.';
    const carried = all.filter((m) => m.until !== null && m.from !== m.to), own = carried.filter((m) => m.by !== null && m.by === m.paidInBy);
    const inn = all.filter((m) => m.kind === 'notes' && m.from === 'world'), out = all.filter((m) => m.kind === 'notes' && m.to === 'world');
    let s = all.length ? `${moneyShort(sum(all))} moved in ${count(all.length)} ${all.length === 1 ? 'move' : 'moves'}.` : 'No money moved between the rows shown.';
    if (carried.length) s += ` ${moneyShort(sum(carried))} likely went from one account to another as banknotes${own.length === carried.length ? ', each time carried by the same player' : own.length ? `, ${moneyShort(sum(own))} of it carried by the same player` : ''}.`;
    if (inn.length) s += ` ${moneyShort(sum(inn))} came in as notes nobody took out of the bank the day before.`;
    if (out.length) s += ` ${moneyShort(sum(out))} left as notes and was not paid back in within a day.`;
    const other = every.length - all.length, pairs = moves.filter((x) => x.goods).length;
    if (other) s += ` Other items moved ${count(other)} ${other === 1 ? 'time' : 'times'}${pairs ? `; ${count(pairs)} ${pairs === 1 ? 'trade shows' : 'trades show'} both sides, marked with a diamond on the market's row` : ''}.`;
    return s;
  });

  // ---- The records behind the picked band ----
  // Keyed by the entry ids, a string, so a zoom that keeps the same moves in the band fetches nothing.
  const want = $derived(pick ? pick.list.flatMap((m) => m.rows).slice(0, 200).join(',') : '');
  let records = $state<{ key: string; rows: LedgerRow[] } | null>(null);
  $effect(() => {
    const key = want;
    if (!key) return;
    let stale = false;
    void engine.ledger({ ids: key.split(',').map(Number) }, { from: null, to: null, server: null }).then((r) => !stale && (records = { key, rows: r }));
    return () => (stale = true);
  });
  const rec = $derived(want && records?.key === want ? records.rows : null);
  const orders = (g: Band) => g.list.reduce((s, m) => s + m.orders.length, 0);
</script>

<p class="lead">{lead}</p>
<section class="card">
  <div class="grid">
    <div class="lists">
      <FilterList bind:off label={byAccount ? 'Accounts on the chart' : 'Players on the chart'} find={byAccount ? 'Find an account' : 'Find a player or account'}
        all={byAccount ? ['Show all accounts', 'Hide all accounts'] : ['Show all players', 'Hide all players']}
        entries={rows.filter((r) => isOwn(r.id)).map((r) => ({ id: r.id, name: r.name }))} />
      {#if items}
        <FilterList bind:off={itemsOff} label="Items on the chart" find="Find an item" all={['Show all items', 'Hide all items']}
          entries={itemList.map((id) => ({ id, name: label(id), color: hue.get(id), note: countShort(Number(volume.get(id) ?? 0n) / 100), hot: app.scope.focus?.markets.includes(id) }))} />
      {/if}
    </div>
    <div style="min-width: 0">
      <p class="readout">
        {#if hover}<span class="dot" style:--c={dot(hover)} aria-hidden="true"></span>{title(hover)}{hover.estimate ? ' (estimate)' : ''} · {figure(hover)} · {when(hover)}
        {:else}Point at a band to see what moved; select it for the details.{/if}
      </p>
      <!-- The chart takes the wheel, drags, the arrow keys and Ctrl+Space itself. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="plot" bind:this={box} bind:clientWidth={cw} style:height="{H}px" role="img" tabindex="0"
        aria-label="{items ? 'Moves' : 'Money moves'} from {time(cur.x0)} to {time(cur.x1)}{pick ? `, picked: ${says(pick)}` : ''}"
        onpointermove={move}
        onpointerdown={(e) => {
          drag = { x: e.clientX, moved: false };
          box!.setPointerCapture(e.pointerId);
          box!.focus();
        }}
        onpointerup={(e) => {
          if (drag && !drag.moved) picked = hit(...local(e))?.list[0] ?? null;
          drag = null;
        }}
        onpointerleave={() => (hover = null)}
      >
        <svg width={cw} height={H} aria-hidden="true">
          <path d={focusSpan(X, H)} class="incident-span" />
          {#each lanes as r, i (r.id)}<path d="M0 {yOf(i)}H{cw}" class="lane" class:place={!isOwn(r.id)} />{/each}
          {#if own && own < lanes.length}<path d="M0 {TOP + own * LANE - 10}H{cw}" class="sep" />{/if}
          {#each bands as g (g.key)}
            <!-- One group per arrow, its opacity on the whole: the pieces overlap at the corners without a darker square. -->
            {#each legs(g) as l, j (j)}
              <g class="band" class:hot={hover?.key === g.key || pick?.key === g.key} style:color={l.color} style:stroke-width="{l.wd.toFixed(1)}px">
                {#each l.pieces as [d, cls], k (k)}<path {d} class={cls} />{/each}
              </g>
            {/each}
            {#if g.goods}<path d={diamond(g)} class="trade" class:hot={hover?.key === g.key || pick?.key === g.key} />{/if}
          {/each}
        </svg>
        {#each lanes as r, i (r.id)}<span class="name" style:top="{yOf(i) - 22}px" title={r.name}>{r.name}</span>{/each}
      </div>
      <div class="xaxis" aria-hidden="true">
        {#each timeTicks([0, 1, 2, 3, 4].map((k) => cur.x0 + ((cur.x1 - cur.x0) * (k + 0.5)) / 5), cur.x1 - cur.x0) as label, k (k)}<span style:left="{((k + 0.5) / 5) * 100}%">{label}</span>{/each}
      </div>
      <p class="legend">
        {#if several}
          {#each itemList.filter((id) => !itemsOff.has(id)) as id (id)}<span><span class="dot" style:--c={hue.get(id)} aria-hidden="true"></span>{label(id)}</span>{/each}
          <span>The colour shows the item, the row an arrow goes to what kind of move it is. A diamond on a market's row marks a trade with both sides shown: two arrows, the money to the market and the items back, or the other way round.</span>
        {:else}
          {#each Object.entries(KIND) as [k, name] (k)}<span><span class="dot" style:--c={COLOR[k as TimelineMove['kind']]} aria-hidden="true"></span>{name}</span>{/each}
        {/if}
        <span>Below the line: the markets and other places something shown went to. A trade shows only when all its items are on: the item and the money, or both items of an inter-market order, whose money goes as an arrow from one market straight on to the other.</span>
        <span>The arrow points to where {items ? 'it' : 'the money'} went. Band thickness grows with the amount{several ? ', each item on its own scale' : ''}; a few of the largest share the full width. Dashed: notes matched by their amount, an estimate. Scroll to zoom the time, drag to move it, the arrow keys step through the moves, Ctrl+Space shows everything.</span>
      </p>
    </div>
  </div>
</section>

{#if pick}
  <section class="card detail" aria-label="The picked move">
    <div class="dleft">
      <h2 class="dtitle">{title(pick)}</h2>
      <p class="damount">{pick.estimate ? 'about ' : ''}{pick.goods ? val(pick.goods.item, pick.goods.amount) : val(pick.item, pick.amount)}</p>
      {#if pick.goods}<p class="small" style="margin: 0">for {money(pick.amount)}</p>{/if}
      <p class="small" style="margin: 0">{when(pick)}</p>
      <span class="badge" class:est={pick.estimate}>{pick.estimate ? 'Estimate' : 'Proven'}</span>
    </div>
    <div class="dright">
      <p class="dtext">{says(pick)}</p>
      <p class="small" style="margin: 8px 0 0">
        {#each [...new Set(pick.list.flatMap((m) => [m.from, m.to]).filter((p) => typeof p === 'number'))] as a, k (a)}{k ? ', ' : 'Open '}<a class="ref" href="#/accounts/{a}">account {a}</a>{/each}
      </p>
      {#if rec?.length}
        <table>
          <thead><tr><th>Time</th><th>Account</th><th>Entry</th><th class="r">Amount</th></tr></thead>
          <tbody>
            {#each rec.slice(0, 20) as r (r.id)}
              <tr><td class="mono">{time(r.time)}</td><td><a class="ref" href="#/accounts/{r.account}">{r.account}</a></td><td>{w.what(r)}</td><td class="r">{w.amount(r)}</td></tr>
            {/each}
          </tbody>
        </table>
        {#if rec.length > 20}<p class="small" style="margin: 8px 0 0">The first 20 of {count(rec.length)} log entries.</p>{/if}
      {/if}
      {#if orders(pick)}<p class="small" style="margin: 8px 0 0">{count(orders(pick))} orders stand in for trades the log did not record.</p>{/if}
    </div>
  </section>
{/if}
<p class="small" style="margin: 0">
  The time range of the top bar applies, every server.{tl.unknown ? ` ${count(tl.unknown)} log entries without a direction are left out.` : ''}
  {byAccount ? '' : 'A personal account is shown as its owner; shared and company accounts keep a row of their own.'}
</p>

<style>
  .lead { margin: 0; max-width: 820px; font-size: 16px; line-height: 24px; text-wrap: pretty; }
  .grid { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; }
  .lists { display: flex; flex-direction: column; gap: 24px; min-width: 0; }
  .readout { margin: 0 0 8px; min-height: 20px; font-size: 13px; color: var(--text2); font-variant-numeric: tabular-nums; }
  .plot { position: relative; overflow: hidden; cursor: crosshair; touch-action: none; user-select: none; border-radius: 4px; }
  .plot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plot svg { position: absolute; left: 0; top: 0; }
  .lane { stroke: var(--line2); stroke-width: 1; }
  .lane.place { stroke-dasharray: 2 4; }
  .sep { stroke: var(--text3); stroke-width: 1.5; }
  .band { fill: none; stroke: currentColor; opacity: 0.55; stroke-linecap: butt; }
  .band.hot { opacity: 0.95; }
  .dash { stroke-dasharray: 6 5; }
  .head { fill: currentColor; stroke: none; }
  .trade { fill: var(--card); stroke: var(--text2); stroke-width: 1.5; }
  .trade.hot { stroke: var(--text); }
  .name { position: absolute; left: 0; max-width: 60%; padding: 0 6px 0 0; font-size: 13px; line-height: 18px; color: var(--text2); background: var(--card); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
  .xaxis { position: relative; height: 16px; margin-top: 8px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .xaxis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 12px 0 0; font-size: 13px; color: var(--text2); }
  .dot { display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 3px; background: var(--c); vertical-align: -1px; }
  .detail { display: flex; flex-wrap: wrap; gap: 24px 40px; padding: 28px; }
  .dleft { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .dright { flex: 2 1 380px; min-width: 0; }
  .dtitle { margin: 0; font-family: var(--font-head); font-size: 22px; line-height: 30px; font-weight: 600; }
  .damount { margin: 0; font-family: var(--font-head); font-size: 28px; line-height: 36px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
  .dtext { margin: 0; font-size: 15px; line-height: 24px; text-wrap: pretty; }
  .badge { height: 24px; padding: 0 8px; box-sizing: border-box; border-radius: 6px; font-size: 12px; line-height: 22px; font-weight: 500; color: var(--text2); border: 1px solid var(--line2); }
  .badge.est { color: var(--high); border: 1px dashed var(--high); }
  .ref { color: var(--accent); }
  table { width: 100%; margin-top: 16px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 16px 8px 0; font-size: 12px; font-weight: 600; color: var(--text3); text-align: left; }
  td { padding: 8px 16px 8px 0; border-top: 1px solid var(--line); white-space: nowrap; }
  .r { text-align: right; }
  .mono { font-family: var(--font-mono); font-size: 13px; }
</style>

<script lang="ts">
  // The money flow over time: one row per account (or per player, whose personal accounts become one row) and one per
  // place money goes outside the accounts: notes in the world, the markets, an admin, other entries, nowhere the log says.
  // Every move is a band from one row to the other at its time, as thick as the square root of the amount. Notes paid
  // into another account at the amount taken out shortly before run through the World row, dashed: an estimate.
  // Moves closer than a few pixels between the same rows are drawn as one; zoom and drag the time as on the other charts.
  import type { AccountListRow, FlowTimeline, LedgerRow, Place, TimelineMove } from '../../shared/api.ts';
  import { count, money, moneyShort, time } from '../../shared/fmt.ts';
  import { engine } from './state.svelte.ts';
  import FilterList from './FilterList.svelte';
  import type { words } from './words.ts';
  import { pan, timeTick, wheel, type View } from './zoom.ts';

  let { tl, accounts, byAccount, w }: { tl: FlowTimeline; accounts: AccountListRow[]; byAccount: boolean; w: ReturnType<typeof words> } = $props();

  // ---- Rows ----
  const SPECIAL: Record<Exclude<Place, number>, string> = {
    world: 'World: notes outside the bank', markets: 'Markets', admin: 'Admin', other: 'Other entries', unexplained: 'Not explained',
  };
  const ORDER: Exclude<Place, number>[] = ['world', 'markets', 'admin', 'other', 'unexplained'];
  const SHOWN = 8; // account or player rows shown at first, the most money moved first
  const acct = $derived(new Map(accounts.map((a) => [a.number, a])));
  const nameOf = $derived(new Map(tl.players.map((p) => [p.uuid, p.name])));
  /** The row a place is drawn on: a personal account is its owner's row when players are shown. */
  function rowOf(p: Place): { id: string; name: string } {
    if (typeof p === 'string') return { id: p, name: SPECIAL[p] };
    const a = acct.get(p);
    if (!byAccount && a?.owner && !a.company) return { id: `p:${a.owner}`, name: a.ownerName ?? 'A player' };
    return { id: `a:${p}`, name: a ? `Account ${p} · ${a.deleted ? 'deleted' : a.name}` : `Account ${p}` };
  }
  const rows = $derived.by(() => {
    const seen = new Map<string, { id: string; name: string; v: bigint }>();
    for (const m of tl.moves) for (const r of [rowOf(m.from), rowOf(m.to)]) (seen.get(r.id) ?? seen.set(r.id, { ...r, v: 0n }).get(r.id)!).v += m.amount;
    const own = [...seen.values()].filter((r) => !(ORDER as string[]).includes(r.id)).sort((a, b) => Number(b.v - a.v));
    return [...own, ...ORDER.flatMap((id) => seen.get(id) ?? [])];
  });
  // Rows switched off; other rows (the switch between players and accounts) start again with the largest few.
  let off = $derived(new Set<string | number>(rows.filter((r) => r.id.startsWith('a:') || r.id.startsWith('p:')).slice(SHOWN).map((r) => r.id)));
  const lanes = $derived(rows.filter((r) => !off.has(r.id)));
  const laneIndex = $derived(new Map(lanes.map((r, i) => [r.id, i])));
  /** The moves between two rows shown; a move within one row only when it ran through the world. */
  const moves = $derived(tl.moves.flatMap((m) => {
    const a = laneIndex.get(rowOf(m.from).id), b = laneIndex.get(rowOf(m.to).id);
    return a === undefined || b === undefined || (a === b && m.until === null) ? [] : [{ m, a, b }];
  }));

  // ---- Time and zoom ----
  const bounds = $derived.by(() => {
    if (!moves.length) return { from: 0, to: 1, minSpan: 1 };
    const lo = moves[0]!.m.time, hi = Math.max(...moves.map((x) => x.m.until ?? x.m.time)), pad = Math.max(30_000, (hi - lo) * 0.03);
    return { from: lo - pad, to: hi + pad, minSpan: 10_000 };
  });
  let manual = $derived((void moves, null as View | null));
  const cur = $derived(manual ?? { x0: bounds.from, x1: bounds.to, y0: 0, y1: 1 });

  const LANE = 56, TOP = 28, MAXW = 22;
  let cw = $state(900);
  const H = $derived(TOP + lanes.length * LANE);
  const yOf = (i: number) => TOP + i * LANE + 20;
  const X = (t: number) => ((t - cur.x0) / (cur.x1 - cur.x0)) * cw;

  // ---- Bands: moves between the same rows within a few pixels are one ----
  interface Band { key: string; list: TimelineMove[]; a: number; b: number; xa: number; xb: number; amount: bigint; kind: TimelineMove['kind']; carried: boolean; estimate: boolean }
  const bands = $derived.by(() => {
    const out = new Map<string, Band>(), cell = (t: number) => Math.floor(X(t) / 6);
    for (const { m, a, b } of moves) {
      const end = m.until ?? m.time;
      if (X(end) < -40 || X(m.time) > cw + 40) continue;
      const key = [a, b, m.kind, m.until !== null, cell(m.time), m.until === null ? '' : cell(m.until)].join('|');
      const g = out.get(key) ?? out.set(key, { key, list: [], a, b, xa: X(m.time), xb: X(end), amount: 0n, kind: m.kind, carried: m.until !== null, estimate: false }).get(key)!;
      g.list.push(m);
      g.amount += m.amount;
      g.estimate ||= m.basis === 'estimate';
    }
    return [...out.values()].sort((p, q) => p.xa - q.xa);
  });
  // The full width is four times the 90th percentile band, at most the largest: one huge move (a company's opening
  // balance) gets the full width and leaves the others readable instead of flattening them.
  const most = $derived.by(() => {
    const v = bands.map((g) => g.amount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const p90 = v[Math.floor((v.length - 1) * 0.9)] ?? 1n, top = v.at(-1) ?? 1n;
    return top < p90 * 4n ? top : p90 * 4n;
  });
  const width = (g: Band) => Math.min(MAXW, Math.max(2, Math.sqrt(Number(g.amount) / Number(most)) * MAXW));
  const world = $derived(laneIndex.get('world'));
  /** Straight pieces with flat ends: [path, dashed]. A move is one vertical band at its time. */
  function path(g: Band): [string, boolean][] {
    const ya = yOf(g.a), yb = yOf(g.b), f = (v: number) => v.toFixed(1);
    if (!g.carried) return [[`M${f(g.xa)} ${ya}V${yb}`, false]];
    // Down to the world row (the other row when it is off), along it while the notes were out (dashed: matched by the
    // amount), up into the other account. The verticals reach half a width past the row to fill the corners.
    const yv = yOf(world ?? g.b), h = width(g) / 2, down = (x: number, y: number): [string, boolean][] => (y === yv ? [] : [[`M${f(x)} ${y}V${f(yv + Math.sign(yv - y) * h)}`, false]]);
    return [...down(g.xa, ya), [`M${f(g.xa)} ${yv}H${f(g.xb)}`, true], ...down(g.xb, yb)];
  }
  const COLOR: Record<TimelineMove['kind'], string> = { notes: 'var(--high)', trade: 'var(--buy)', transfer: 'var(--accent)', admin: 'var(--crit)', other: 'var(--text3)', unexplained: 'var(--med)' };
  const KIND: Record<TimelineMove['kind'], string> = { notes: 'Notes', trade: 'Trading', transfer: 'Transfer', admin: 'Admin', other: 'Other entries', unexplained: 'Not explained' };

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
  const place = (p: Place) => (typeof p === 'number' ? `account ${p}` : SPECIAL[p].toLowerCase());
  const who = (u: string | null) => (u === null ? 'someone the log does not name' : nameOf.get(u) ?? 'a player');
  const span = (ms: number) => {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? `${count(s)} s` : s < 3600 ? `${count(Math.round(s / 60))} min` : `${count(Math.round(s / 3600))} h`;
  };
  /** One band in a sentence. */
  function says(g: Band): string {
    const m = g.list[0]!, n = g.list.length, many = n > 1 ? `${count(n)} moves, ` : '';
    if (g.carried) {
      const same = g.list.every((x) => x.by !== null && x.by === x.paidInBy);
      return `${many}${money(g.amount)} left ${place(m.from)} as banknotes and the same amount was paid into ${place(m.to)} ${span(m.until! - m.time)} later, by ${same ? `the same player, ${who(m.by)}` : `${who(m.paidInBy)} after ${who(m.by)} took it out`}. Likely the same money, carried through the world.`;
    }
    switch (m.kind) {
      case 'notes': return m.to === 'world'
        ? `${many}${money(g.amount)} taken out of ${place(m.from)} as banknotes by ${who(m.by)}. No deposit of the same amount followed within a day, so where the notes went is not known.`
        : `${many}${money(g.amount)} in banknotes paid into ${place(m.to)} by ${who(m.paidInBy)}. Nobody took the same amount out within the day before: the notes come from an earlier withdrawal, from several, or from outside the bank.`;
      case 'trade': return `${many}${money(g.amount)} ${m.to === 'markets' ? `spent on the markets by ${place(m.from)}` : `received from the markets by ${place(m.to)}`}.`;
      case 'transfer': return `${many}${money(g.amount)} transferred from ${place(m.from)} to ${place(m.to)}.`;
      case 'admin': return `${many}${money(g.amount)} ${m.to === 'admin' ? `removed from ${place(m.from)}` : `added to ${place(m.to)}`} by an admin.`;
      case 'other': return `${many}${money(g.amount)} ${m.to === 'other' ? `left ${place(m.from)}` : `came into ${place(m.to)}`} through other log entries: payouts, dividends, changes from an unknown source.`;
      default: return `${many}${money(g.amount)} ${m.to === 'unexplained' ? `left ${place(m.from)}` : `came into ${place(m.to)}`} between two balance snapshots, and the log has no entry for it.`;
    }
  }
  const when = (g: Band) => (g.carried ? `${time(g.list[0]!.time)} to ${time(g.list.at(-1)!.until!)}` : g.list.length > 1 ? `${time(g.list[0]!.time)} to ${time(g.list.at(-1)!.time)}` : time(g.list[0]!.time));

  // The answer first: what moved, and what the notes did.
  const lead = $derived.by(() => {
    const all = moves.map((x) => x.m), sum = (l: TimelineMove[]) => l.reduce((s, m) => s + m.amount, 0n);
    if (!all.length) return 'No money moved between the rows shown in this time range.';
    const carried = all.filter((m) => m.until !== null && m.from !== m.to), own = carried.filter((m) => m.by !== null && m.by === m.paidInBy);
    const inn = all.filter((m) => m.kind === 'notes' && m.from === 'world'), out = all.filter((m) => m.kind === 'notes' && m.to === 'world');
    let s = `${moneyShort(sum(all))} moved in ${count(all.length)} ${all.length === 1 ? 'move' : 'moves'}.`;
    if (carried.length) s += ` ${moneyShort(sum(carried))} likely went from one account to another as banknotes${own.length === carried.length ? ', each time carried by the same player' : own.length ? `, ${moneyShort(sum(own))} of it carried by the same player` : ''}.`;
    if (inn.length) s += ` ${moneyShort(sum(inn))} came in as notes nobody took out of the bank the day before.`;
    if (out.length) s += ` ${moneyShort(sum(out))} left as notes and was not paid back in within a day.`;
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
    <FilterList bind:off label="Rows on the chart" find={byAccount ? 'Find an account' : 'Find a player or account'} all={['Show all rows', 'Hide all rows']}
      entries={rows.map((r) => ({ id: r.id, name: r.name }))} />
    <div style="min-width: 0">
      <p class="readout">
        {#if hover}<span class="dot" style:--c={COLOR[hover.kind]} aria-hidden="true"></span>{KIND[hover.kind]}{hover.estimate ? ' (estimate)' : ''} · {moneyShort(hover.amount)} · {when(hover)}
        {:else}Point at a band to see what moved; select it for the details.{/if}
      </p>
      <!-- The chart takes the wheel, drags, the arrow keys and Ctrl+Space itself. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="plot" bind:this={box} bind:clientWidth={cw} style:height="{H}px" role="img" tabindex="0"
        aria-label="Money moves from {time(cur.x0)} to {time(cur.x1)}{pick ? `, picked: ${says(pick)}` : ''}"
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
          {#each lanes as r, i (r.id)}<path d="M0 {yOf(i)}H{cw}" class="lane" class:place={!r.id.includes(':')} />{/each}
          {#each bands as g (g.key)}
            <!-- One group, its opacity on the whole: the pieces overlap at the corners without a darker square. -->
            <g class="band" class:hot={hover?.key === g.key || pick?.key === g.key} style:stroke={COLOR[g.kind]} style:stroke-width="{width(g).toFixed(1)}px">
              {#each path(g) as [d, dash], k (k)}<path {d} class:dash />{/each}
            </g>
          {/each}
        </svg>
        {#each lanes as r, i (r.id)}<span class="name" style:top="{yOf(i) - 22}px" title={r.name}>{r.name}</span>{/each}
      </div>
      <div class="xaxis" aria-hidden="true">
        {#each [0, 1, 2, 3, 4] as k (k)}<span style:left="{((k + 0.5) / 5) * 100}%">{timeTick(cur.x0 + ((cur.x1 - cur.x0) * (k + 0.5)) / 5, cur.x1 - cur.x0)}</span>{/each}
      </div>
      <p class="legend">
        {#each Object.entries(KIND) as [k, label] (k)}<span><span class="dot" style:--c={COLOR[k as TimelineMove['kind']]} aria-hidden="true"></span>{label}</span>{/each}
        <span>Band thickness grows with the amount; a few of the largest share the full width. Dashed: notes matched by their amount, an estimate. Scroll to zoom the time, drag to move it, the arrow keys step through the moves, Ctrl+Space shows everything.</span>
      </p>
    </div>
  </div>
</section>

{#if pick}
  <section class="card detail" aria-label="The picked move">
    <div class="dleft">
      <h2 class="dtitle">{pick.carried ? 'Carried as notes' : KIND[pick.kind]}</h2>
      <p class="damount">{pick.estimate ? 'about ' : ''}{money(pick.amount)}</p>
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
  .readout { margin: 0 0 8px; min-height: 20px; font-size: 13px; color: var(--text2); font-variant-numeric: tabular-nums; }
  .plot { position: relative; overflow: hidden; cursor: crosshair; touch-action: none; user-select: none; border-radius: 4px; }
  .plot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plot svg { position: absolute; left: 0; top: 0; }
  .lane { stroke: var(--line2); stroke-width: 1; }
  .lane.place { stroke-dasharray: 2 4; }
  .band { fill: none; opacity: 0.55; stroke-linecap: butt; }
  .band.hot { opacity: 0.95; }
  .dash { stroke-dasharray: 6 5; }
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

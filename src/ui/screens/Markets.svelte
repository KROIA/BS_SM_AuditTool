<script lang="ts">
  // Markets: what happened to this price, and who did it? A list on the left, the picked market on the right.
  // The list puts the markets with open findings first, then the largest swing.
  import type { Candle, Finding, ItemRow, Level, MarketFacts, MarketRow, OrderRow, Scope, Trader } from '../../shared/api.ts';
  import { amount, count, countShort, items as quantity, money, moneyShort } from '../../shared/fmt.ts';
  import CandleChart from '../app/CandleChart.svelte';
  import FindingLinks from '../app/FindingLinks.svelte';
  import { app, engine, setRange } from '../app/state.svelte.ts';
  import { LEVEL_COLOR, tone, words } from '../app/words.ts';

  let { selected }: { selected: number | null } = $props();

  type Minutes = 1 | 5 | 15 | 60 | 1440;
  const MIN = 60_000;
  const LENGTHS: [Minutes, string][] = [[1, '1 min'], [5, '5 min'], [15, '15 min'], [60, '1 hour'], [1440, '1 day']];
  /** Without a picked length the chart takes the shortest one that gives at most this many candles. */
  const FIT = 600;

  let list = $state<MarketRow[] | null>(null);
  let found = $state<Finding[]>([]);
  let itemRows = $state(new Map<number, ItemRow>());
  let facts = $state<MarketFacts | null>(null);
  let traders = $state<Trader[]>([]);
  let loadedFor = $state<number | null>(null);
  let chart = $state<{ candles: Candle[]; capped: boolean; minutes: Minutes } | null>(null);
  let picked = $state<Minutes | null>(null); // the candle length the user picked
  let range = $state<{ from: number; to: number } | null>(null); // the zoomed-in span a new candle length was asked for
  let view = $state<{ from: number; to: number } | null>(null); // the span the chart shows while zoomed in
  let log = $state(true);
  let showUsual = $state(true);
  let trader = $state<string | null>(null);
  let traderOrders = $state<OrderRow[]>([]);

  const main = $derived(app.saves.find((s) => s.sources.some((x) => x.id === 'market' && x.status !== 'none' && x.status !== 'missing')));
  // Open findings per market, with the highest level (findings come highest level first); the engine's swing order breaks ties.
  const open = $derived(found.filter((f) => !app.marks[f.id]?.dismissed));
  const flags = $derived.by(() => {
    const out = new Map<number, { n: number; level: Level }>();
    for (const f of open) for (const m of f.markets) out.set(m, { n: (out.get(m)?.n ?? 0) + 1, level: out.get(m)?.level ?? f.level });
    return out;
  });
  const ordered = $derived(list ? [...list].sort((a, b) => (flags.get(b.item)?.n ?? 0) - (flags.get(a.item)?.n ?? 0)) : null);
  const item = $derived(selected ?? ordered?.[0]?.item ?? null);
  const standouts = $derived(open.filter((f) => f.markets.includes(item!)));
  const ready = $derived(loadedFor !== null && loadedFor === item);
  const row = $derived(list?.find((m) => m.item === item) ?? null);
  const { itemName, isMoney } = $derived(words(itemRows));

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length; // ask again when saves come or go
    let stale = false;
    void Promise.all([engine.markets(scope), engine.items(), engine.findings(scope, rules)]).then(([m, i, f]) => {
      if (stale) return;
      [list, found] = [m, f.findings];
      itemRows = new Map(i.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), i = item;
    void app.saves.length;
    if (i === null) return;
    let stale = false;
    void Promise.all([engine.market(i, scope), engine.traders(i, scope)]).then(([f, t]) => {
      if (stale) return;
      if (loadedFor !== i) [picked, range, trader, chart] = [null, null, null, null];
      else range = null; // a new time range of the tool replaces the zoom
      [facts, traders, loadedFor] = [f, t, i];
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), i = item, m = picked, r = $state.snapshot(range);
    if (i === null || !ready) return;
    const s: Scope = r ? { ...scope, from: r.from, to: r.to } : scope;
    let stale = false;
    void (async () => {
      let minutes = m, got: { candles: Candle[]; capped: boolean } | null = null;
      if (minutes === null) {
        // The hour candles are quick to read and tell how long the range is.
        const probe = await engine.candles(i, 60, s);
        const c = probe.candles, span = c.length ? c.at(-1)!.time + 60 * MIN - c[0]!.time : 0;
        minutes = LENGTHS.find(([x]) => span <= FIT * x * MIN)?.[0] ?? 1440;
        if (minutes === 60) got = probe;
      }
      got ??= await engine.candles(i, minutes, s);
      if (!stale) chart = { ...got, minutes };
    })();
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), i = item, t = trader;
    if (i === null || t === null) return;
    let stale = false;
    void engine.orders({ player: t, item: i }, scope).then((o) => !stale && (traderOrders = o));
    return () => ((stale = true), (traderOrders = []));
  });

  /** A new candle length: while zoomed in, it is read for the span on screen only. */
  function pick(m: Minutes) {
    range = view ?? range;
    picked = m;
  }
  function wholeRange() {
    [range, picked] = [null, null];
  }
  /** The span on screen becomes the time range of the whole tool. */
  function useAsRange() {
    const v = view ?? range;
    if (!v) return;
    [range, picked] = [null, null];
    setRange('custom', v.from, v.to);
  }

  // From 100x on, decimals add nothing: 5'515'856x, not 5'515'856.00x.
  const swing = (s: number) => (s >= 100 ? count(Math.round(s)) : amount(BigInt(Math.round(s * 100)))) + '×';
  const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  const signed = (raw: bigint) => (raw > 0n ? '+' : '') + moneyShort(raw);
  const traderName = $derived(traders.find((t) => t.uuid === trader)?.name ?? '');

  // A marker sits where the order finished when the save records it (StockMarket since SM-317), else where it was placed.
  const marks = $derived(traderOrders.map((o) => ({ time: o.finishMs ?? o.time, price: o.price, buy: o.amount > 0n })));
  const basis = (list: OrderRow[]) => {
    const finished = list.filter((o) => o.finishMs !== null).length;
    return finished === list.length ? 'finished' : finished === 0 ? 'placed' : 'mixed';
  };
  const WHEN = {
    finished: ['that finished', 'finished'],
    placed: ['placed', 'was placed: this save does not record when orders finished'],
    mixed: ['that finished, or were placed where the save does not say', 'finished, or was placed where the save does not record when it finished'],
  } as const;
  /** The picked player's orders in one candle, for the readout. */
  function describe(from: number, to: number): string {
    const inside = traderOrders.filter((o) => {
      const t = o.finishMs ?? o.time;
      return t >= from && t < to;
    });
    if (inside.length === 0) return '';
    const side = (buy: boolean) => {
      const own = inside.filter((o) => o.amount > 0n === buy);
      if (own.length === 0) return '';
      const qty = own.reduce((s, o) => s + o.amount, 0n), paid = own.reduce((s, o) => s + o.money, 0n);
      return `${buy ? 'bought' : 'sold'} ${quantity(buy ? qty : -qty)} at ${money((paid * 100n) / qty)}`;
    };
    return `${traderName} ${[side(true), side(false)].filter(Boolean).join(' and ')}, orders ${WHEN[basis(inside)][0]} in this candle`;
  }

  const figures = $derived.by(() => {
    if (!facts) return [];
    const f = facts;
    return [
      { label: 'Usual price', value: f.usual === null ? 'no data' : money(f.usual), title: 'The middle opening price of the 1-minute candles in this time range' },
      { label: 'Lowest', value: f.low === null ? 'no candles' : money(f.low), title: '' },
      { label: 'Highest', value: f.high === null ? 'no candles' : money(f.high), title: '' },
      { label: 'Volume', value: countShort(f.volume), title: count(f.volume) + ' (the mods keep volumes as floating-point numbers, so the last digits are not exact)' },
      { label: 'Players who traded', value: count(f.traders), title: '' },
      ...(row?.price != null ? [{ label: 'Price when the save was taken', value: money(row.price), title: '' }] : []),
    ];
  });
</script>

<div class="split">
  <aside aria-label="Market list">
    <div class="listhead">
      <h2>Markets</h2>
      <span class="small">most findings first</span>
    </div>
    {#if !main}
      <p class="small pad">No save with market data is loaded.</p>
    {:else if list && list.length === 0}
      <p class="small pad">This save has no markets.</p>
    {:else if ordered}
      <div class="roster">
        {#each ordered as m (m.item)}
          <a class="row pick" href="#/markets/{m.item}" aria-current={m.item === item ? 'true' : undefined}>
            <span class="who">
              <span class="ellipsis" style="font-weight: 500">{itemName(m.item)}</span>
              <span class="small">{count(m.orders)} {m.orders === 1 ? 'order' : 'orders'}{m.price !== null ? ` · ${moneyShort(m.price)}` : ''}</span>
            </span>
            <span class="num small" title="Highest price divided by the lowest in this time range">{m.swing === null ? '' : swing(m.swing)}</span>
            {#if flags.get(m.item)}
              {@const x = flags.get(m.item)!}
              <span class="dot" style="background: {LEVEL_COLOR[x.level]}" title="{count(x.n)} open {x.n === 1 ? 'finding' : 'findings'}, the highest {x.level}"></span>
            {/if}
          </a>
        {/each}
      </div>
    {/if}
  </aside>

  <div class="detail">
    {#if !main}
      <div>
        <h1 class="h1">Markets</h1>
        <p class="sub">What happened to this price, and who did it?</p>
      </div>
      <p class="empty">Markets come from the master's save. Open it on the <a href="#/saves" style="color: var(--accent)">Saves and servers</a> screen.</p>
    {:else if item === null}
      <h1 class="h1">Markets</h1>
      {#if list}<p class="empty">This save has no markets.</p>{/if}
    {:else if !ready || !facts}
      <p class="small" aria-busy="true">Loading the market…</p>
    {:else}
      <div>
        <h1 class="h1">{itemName(item)}</h1>
        <p class="sub"><span class="mono">{itemRows.get(item)?.name ?? `item ${item}`}</span> · priced in $ · traded on the master server</p>
      </div>
      {#if row?.swing != null}
        <p class="lead">In this time range the highest price was {swing(row.swing)} the lowest.</p>
      {/if}

      <section aria-label="Market facts" class="mfacts">
        {#each figures as k (k.label)}
          <div title={k.title || undefined}><span class="small">{k.label}</span><span class="mvalue">{k.value}</span></div>
        {/each}
      </section>

      <section class="card">
        <div class="cardhead" style="align-items: center">
          <div role="group" aria-label="Candle length" class="seg">
            {#each LENGTHS as [m, label] (m)}
              <button type="button" aria-pressed={chart?.minutes === m} onclick={() => pick(m)}>{label}</button>
            {/each}
          </div>
          <div role="group" aria-label="Price scale" class="seg">
            <button type="button" aria-pressed={log} onclick={() => (log = true)}>Log</button>
            <button type="button" aria-pressed={!log} onclick={() => (log = false)}>Linear</button>
          </div>
          <button type="button" class="toggle" aria-pressed={showUsual} onclick={() => (showUsual = !showUsual)}><span aria-hidden="true" class="dash"></span>Usual price</button>
          {#if view ?? range}<button type="button" class="link" onclick={useAsRange}>Use as time range</button>{/if}
          {#if range}<button type="button" class="link" onclick={wholeRange}>Show the whole time range</button>{/if}
        </div>
        {#if !chart}
          <p class="small" aria-busy="true" style="margin: 16px 0 0">Loading the candles…</p>
        {:else if chart.candles.length === 0}
          <p class="small" style="margin: 16px 0 0">No candles of this market in this time range.</p>
        {:else}
          <CandleChart candles={chart.candles} minutes={chart.minutes} {log} usual={showUsual ? facts.usual : null} {marks} {describe} bind:view
            label="Price of {itemName(item)} in candles of {LENGTHS.find(([m]) => m === chart!.minutes)![1]}" />
          {#if chart.capped}
            <p class="small" style="margin: 12px 0 0; color: var(--high)">This time range holds more than {count(5000)} candles of this length; the first {count(5000)} are shown. Zoom in and pick a shorter candle, or pick a longer one.</p>
          {/if}
        {/if}
        <div class="legend">
          {#if trader}
            <span class="key"><span aria-hidden="true" class="tri buy"></span>Bought by {traderName}</span>
            <span class="key"><span aria-hidden="true" class="tri"></span>Sold by {traderName}</span>
            <span>Each marker is one order at its average price, at the time it {WHEN[basis(traderOrders)][1]}.</span>
          {:else}
            <span>Pick a player below to see their orders on the chart.</span>
          {/if}
          <span style="color: var(--text3)">Scroll to zoom, drag to move. Close is taken from the next candle's open. Volume bars use a square-root scale.
            Volume counts every trade in the market: players, the price bot and the virtual order book together. The bot's own orders cannot be shown.</span>
        </div>
      </section>

      <div class="pair">
        <section class="card">
          <h2 class="h2 h3">Who traded here</h2>
          <p class="small" style="margin: 2px 0 0">In this time range. Pick a player to put their orders on the chart.</p>
          {#if traders.length === 0}
            <p style="margin: 16px 0 0; color: var(--text2)">No player traded on this market in this time range.</p>
          {:else}
            <div class="traders">
              {#each traders as t (t.uuid)}
                <div class="trow" class:on={t.uuid === trader}>
                  <span class="avatar" aria-hidden="true">{initials(t.name)}</span>
                  <span class="who">
                    <a class="ref" href="#/players/{encodeURIComponent(t.uuid)}" style="font-weight: 500">{t.name}</a>
                    <span class="small">{t.bought ? `bought for ${moneyShort(t.bought)}` : 'bought nothing'}, {t.sold ? `sold for ${moneyShort(t.sold)}` : 'sold nothing'}</span>
                  </span>
                  <span class="num" style="color: {tone(t.profit)}" title="Realised profit">{signed(t.profit)}</span>
                  <button type="button" class="link" aria-pressed={t.uuid === trader} onclick={() => (trader = t.uuid === trader ? null : t.uuid)}
                    >{t.uuid === trader ? 'On the chart' : 'Show on chart'}</button>
                </div>
              {/each}
            </div>
          {/if}
        </section>
        <section class="card" aria-label="What stands out">
          <h2 class="h2 h3">What stands out</h2>
          <FindingLinks list={standouts} w={{ itemName, isMoney }} empty="Nothing unusual in this time range." />
        </section>
      </div>
    {/if}
  </div>
</div>

<style>
  .sub .mono { font-size: 13px; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .pair { display: flex; flex-wrap: wrap; gap: 24px; }
  .pair > .card { flex: 1 1 380px; min-width: 0; box-sizing: border-box; }
  .mfacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); gap: 16px 24px; }
  .mfacts div { display: flex; flex-direction: column; gap: 2px; }
  .mvalue { font-size: 18px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .seg { display: flex; gap: 4px; padding: 4px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
  .seg button { height: 32px; padding: 0 12px; border: 0; border-radius: 7px; font-weight: 500; background: transparent; color: var(--text2); }
  .seg button[aria-pressed='true'] { background: var(--raised); color: var(--text); }
  .toggle { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-radius: 10px; font-weight: 500; border: 1px solid var(--line); background: transparent; color: var(--text2); }
  .toggle[aria-pressed='true'] { border-color: var(--accent); color: var(--accent); }
  .dash { width: 16px; border-top: 2px dashed currentColor; }
  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; margin-top: 16px; font-size: 13px; color: var(--text2); }
  .key { display: inline-flex; align-items: center; gap: 8px; }
  .tri { width: 10px; height: 9px; background: var(--sell); clip-path: polygon(0 0, 100% 0, 50% 100%); }
  .tri.buy { background: var(--buy); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  .traders { display: flex; flex-direction: column; gap: 2px; margin: 12px -10px 0; }
  .trow { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 10px; border-radius: 10px; }
  .trow.on { background: var(--raised); }
  .trow .link[aria-pressed='false'] { color: var(--text3); }
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--raised); color: var(--text2); }
  .trow.on .avatar { background: var(--card); }
</style>

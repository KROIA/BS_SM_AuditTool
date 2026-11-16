<script lang="ts">
  // Markets: what happened to this price, and who did it? A list on the left, the picked market on the right.
  // The list puts the markets with open findings first, then the largest swing.
  import type { Candle, Finding, ItemRow, Level, MarketFacts, MarketRow, OrderRow, Scope, Trader } from '../../shared/api.ts';
  import { amount, count, countShort, items as quantity, money, moneyShort } from '../../shared/fmt.ts';
  import CandleChart from '../app/CandleChart.svelte';
  import CsvButton from '../app/CsvButton.svelte';
  import FindingLinks from '../app/FindingLinks.svelte';
  import { app, engine, setRange } from '../app/state.svelte.ts';
  import { LEVEL_COLOR, tone, words } from '../app/words.ts';
  import { HINT } from '../app/zoom.ts';

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
  type Got = { candles: Candle[]; capped: boolean; usual: (bigint | null)[]; span: { from: number; to: number } | null };
  let chart = $state<Got & { minutes: Minutes; reset: number } | null>(null);
  let end = $state<number | null>(null); // the loaded candles end here while dragging shows older ones; null: the newest
  let resets = 0;
  let picked = $state<Minutes | null>(null); // the candle length the user picked
  let range = $state<{ from: number; to: number } | null>(null); // the zoomed-in span a new candle length was asked for
  let view = $state<{ from: number; to: number } | null>(null); // the span the chart shows while zoomed in
  let log = $state(true);
  let showUsual = $state(true);
  let shown = $state<string[]>([]); // the players whose orders are on the chart
  let itemOrders = $state<OrderRow[]>([]); // every player's orders on this market, read once one is shown

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
      if (loadedFor !== i) [picked, range, shown, chart, end] = [null, null, [], null, null];
      else [range, end] = [null, null]; // a new time range of the tool replaces the zoom
      [facts, traders, loadedFor] = [f, t, i];
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), i = item, m = picked, r = $state.snapshot(range), e = end;
    if (i === null || !ready) return;
    const s: Scope = r ? { ...scope, from: r.from, to: r.to } : scope;
    let stale = false;
    void (async () => {
      let minutes = m, got: Got | null = null;
      if (minutes === null) {
        // The hour candles are quick to read and tell how long the range is.
        const probe = await engine.candles(i, 60, s);
        const c = probe.candles, span = c.length ? c.at(-1)!.time + 60 * MIN - c[0]!.time : 0;
        minutes = LENGTHS.find(([x]) => span <= FIT * x * MIN)?.[0] ?? 1440;
        if (minutes === 60) got = probe;
      }
      got ??= await engine.candles(i, minutes, s, e ?? undefined);
      // Another part of the same candles keeps what the chart shows.
      if (!stale) chart = { ...got, minutes, reset: e === null ? ++resets : resets };
    })();
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), i = item;
    if (i === null || !anyShown) return;
    let stale = false;
    void engine.orders({ item: i }, scope).then((o) => !stale && (itemOrders = o));
    return () => ((stale = true), (itemOrders = []));
  });
  const anyShown = $derived(shown.length > 0);
  const traderOrders = $derived.by(() => {
    const on = new Set(shown);
    return itemOrders.filter((o) => on.has(o.player));
  });
  const allShown = $derived(traders.length > 0 && traders.every((t) => shown.includes(t.uuid)));
  const toggle = (uuid: string) => (shown = shown.includes(uuid) ? shown.filter((x) => x !== uuid) : [...shown, uuid]);

  // More candles than one read gives: the chart then shows at most 4'000 candles' time, and the 5'000 read around it
  // leave room on both sides. Once less than half that room is left on one side, the 5'000 around the view are read.
  $effect(() => {
    const v = view, c = chart;
    if (!v || !c?.capped || !c.span || !c.candles.length) return;
    const iv = c.minutes * MIN, lo = c.candles[0]!.time, hi = c.candles.at(-1)!.time + iv, room = Math.max(0, (5000 * iv - (v.to - v.from)) / 4);
    if ((v.from - room >= lo || lo <= c.span.from) && (v.to + room <= hi || hi >= c.span.to)) return;
    [picked, end] = [c.minutes, Math.min(c.span.to - 1, Math.round((v.from + v.to) / 2 + 2500 * iv))];
  });

  /** A new candle length: while zoomed in, it is read for the span on screen only. */
  function pick(m: Minutes) {
    range = view ?? range;
    [picked, end] = [m, null];
  }
  function wholeRange() {
    [range, picked, end] = [null, null, null];
  }
  /** The span on screen becomes the time range of the whole tool. */
  function useAsRange() {
    const v = view ?? range;
    if (!v) return;
    [range, picked, end] = [null, null, null];
    setRange('custom', v.from, v.to);
  }

  // From 100x on, decimals add nothing: 5'515'856x, not 5'515'856.00x.
  const swing = (s: number) => (s >= 100 ? count(Math.round(s)) : amount(BigInt(Math.round(s * 100)))) + '×';
  const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  const signed = (raw: bigint) => (raw > 0n ? '+' : '') + moneyShort(raw);
  const names = $derived(new Map(traders.map((t) => [t.uuid, t.name])));
  /** The one shown player's name, or how many are shown. */
  const shownName = $derived(shown.length === 1 ? (names.get(shown[0]!) ?? '') : `the ${count(shown.length)} shown players`);

  // A marker sits where the order finished when the save records it (StockMarket since SM-317), else where it was placed.
  const marks = $derived(traderOrders.map((o) => ({
    time: o.finishMs ?? o.time, price: o.price, buy: o.amount > 0n, amount: o.amount < 0n ? -o.amount : o.amount, who: names.get(o.player) ?? o.player,
  })));
  const basis = (list: OrderRow[]) => {
    const finished = list.filter((o) => o.finishMs !== null).length;
    return finished === list.length ? 'finished' : finished === 0 ? 'placed' : 'mixed';
  };
  const WHEN = {
    finished: ['that finished', 'finished'],
    placed: ['placed', 'was placed: this save does not record when orders finished'],
    mixed: ['that finished, or were placed where the save does not say', 'finished, or was placed where the save does not record when it finished'],
  } as const;
  /** The shown players' orders in one candle, for the readout. */
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
    const who = new Set(inside.map((o) => o.player));
    const name = who.size === 1 ? (names.get([...who][0]!) ?? '') : `${count(who.size)} players`;
    return `${name} ${[side(true), side(false)].filter(Boolean).join(' and ')}, orders ${WHEN[basis(inside)][0]} in this candle`;
  }

  // ---- CSV (AT-44) ----
  const listTable = () => ({
    columns: [['Market', 'text'], ['Item', 'id'], ['Item id', 'id'], ['Orders', 'count'], ['Price when the save was taken', 'money'], ['Lowest', 'money'], ['Highest', 'money'],
      ['Swing (highest / lowest)', 'number'], ['Open findings', 'count'], ['Highest level', 'text']] as const,
    rows: (ordered ?? []).map((m) => [itemName(m.item), itemRows.get(m.item)?.name, m.item, m.orders, m.price, m.low, m.high, m.swing, flags.get(m.item)?.n ?? 0, flags.get(m.item)?.level]),
  });
  const traderTable = (i: number) => ({
    columns: [['Player', 'text'], ['Player uuid', 'id'], ['Market', 'text'], ['Item id', 'id'], ['Bought', 'money'], ['Sold', 'money'], ['Realised profit', 'money']] as const,
    rows: traders.map((t) => [t.name, t.uuid, itemName(i), i, t.bought, t.sold, t.profit]),
  });

  const figures = $derived.by(() => {
    if (!facts) return [];
    const f = facts;
    return [
      { label: 'Usual price', value: f.usual === null ? 'no data' : money(f.usual), title: 'At the end of this time range: the middle opening price of the last 1\'440 one-minute candles before it' },
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
    {#if ordered?.length}<div class="listcsv"><CsvButton screen="markets" table="list" what="the market list" make={listTable} /></div>{/if}
    {#if !main}
      <p class="small pad">No save with market data is loaded.</p>
    {:else if list && list.length === 0}
      <p class="small pad">This save has no markets.</p>
    {:else if ordered}
      <div class="roster">
        {#each ordered as m (m.item)}
          {@const involved = app.scope.focus?.markets.includes(m.item) ?? false}
          <a class="row pick" class:involved href="#/markets/{m.item}" aria-current={m.item === item ? 'true' : undefined}>
            <span class="who">
              <span class="ellipsis" style="font-weight: 500">{itemName(m.item)}</span>
              <span class="small">{involved ? 'In the incident · ' : ''}{count(m.orders)} {m.orders === 1 ? 'order' : 'orders'}{m.price !== null ? ` · ${moneyShort(m.price)}` : ''}</span>
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
          <CandleChart candles={chart.candles} span={chart.capped ? chart.span : null} reset={chart.reset} minutes={chart.minutes} {log} usual={showUsual ? chart.usual : null} {marks} {describe} bind:view
            label="Price of {itemName(item)} in candles of {LENGTHS.find(([m]) => m === chart!.minutes)![1]}" />
          {#if chart.capped}
            <p class="small" style="margin: 12px 0 0; color: var(--high)">This time range holds more than {count(5000)} candles of this length. The chart starts with the newest {count(5000)} and reads the others as you drag it.</p>
          {/if}
        {/if}
        <div class="legend">
          {#if shown.length}
            <span class="key"><span aria-hidden="true" class="tri buy"></span>Bought by {shownName}</span>
            <span class="key"><span aria-hidden="true" class="tri"></span>Sold by {shownName}</span>
            <span>Each marker is one order at its average price, at the time it {WHEN[basis(traderOrders)][1]}.
              Markers closer than a marker merge into one; point at it to see who traded how much.</span>
          {:else}
            <span>Pick a player below to see their orders on the chart.</span>
          {/if}
          <span style="color: var(--text3)">{HINT} A grey line: no candle in the save, so no prices were made and the price stayed until the next candle opened.
            Close is taken from the next candle's open. Volume bars use a square-root scale.
            Volume counts every trade in the market: players, the price bot and the virtual order book together. The bot's own orders cannot be shown.</span>
        </div>
      </section>

      <div class="pair">
        <section class="card">
          <div class="cardhead">
            <h2 class="h2 h3" style="flex: 1 1 auto">Who traded here</h2>
            {#if traders.length > 1}
              <button type="button" class="link" onclick={() => (shown = allShown ? [] : traders.map((t) => t.uuid))}
                >{allShown ? 'Hide all from the chart' : 'Show all on the chart'}</button>
            {/if}
            {#if traders.length}<CsvButton screen="markets" table="traders-{item}" what="who traded here" make={() => traderTable(item)} />{/if}
          </div>
          <p class="small" style="margin: 2px 0 0">In this time range. Pick players to put their orders on the chart.</p>
          {#if traders.length === 0}
            <p style="margin: 16px 0 0; color: var(--text2)">No player traded on this market in this time range.</p>
          {:else}
            <div class="traders">
              {#each traders as t (t.uuid)}
                <div class="trow" class:on={shown.includes(t.uuid)}>
                  <span class="avatar" aria-hidden="true">{initials(t.name)}</span>
                  <span class="who">
                    <a class="ref" href="#/players/{encodeURIComponent(t.uuid)}" style="font-weight: 500">{t.name}</a>
                    <span class="small">{t.bought ? `bought for ${moneyShort(t.bought)}` : 'bought nothing'}, {t.sold ? `sold for ${moneyShort(t.sold)}` : 'sold nothing'}</span>
                  </span>
                  <span class="num" style="color: {tone(t.profit)}" title="Realised profit">{signed(t.profit)}</span>
                  <button type="button" class="link" aria-pressed={shown.includes(t.uuid)} onclick={() => toggle(t.uuid)}
                    >{shown.includes(t.uuid) ? 'On the chart' : 'Show on chart'}</button>
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
  /* A market of the incident picked in the top bar. */
  .involved { box-shadow: inset 3px 0 0 var(--accent); }
  .involved .ellipsis { color: var(--accent); }
</style>

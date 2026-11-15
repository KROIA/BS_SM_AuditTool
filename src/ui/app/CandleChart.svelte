<script lang="ts">
  // Candles on a time axis with their volume below, a readout of the candle under the pointer, and zoom and pan as in
  // StockMarket's own chart (zoom.ts). Where the save has no candle, the server made no prices: the price stayed until
  // the next candle opened, and a grey line holds it there, as the game fills such gaps with flat candles.
  // Prices are bigints; only the drawing goes through a float.
  import type { Candle } from '../../shared/api.ts';
  import { count, countShort, money, time } from '../../shared/fmt.ts';
  import { pan, wheel, type View } from './zoom.ts';

  interface Mark { time: number; price: bigint; buy: boolean }
  let {
    candles, minutes, log, usual, marks, label, describe, view = $bindable(null),
  }: {
    candles: Candle[];
    minutes: number;
    log: boolean;
    /** The dashed line, one price per candle (null: no point there); null hides it. */
    usual: (bigint | null)[] | null;
    marks: Mark[];
    label: string;
    /** More words for the readout of one candle, from its start to its end (exclusive). */
    describe: (from: number, to: number) => string;
    /** The time span shown while zoomed in; null when every candle is shown. */
    view?: { from: number; to: number } | null;
  } = $props();

  const W = 1000, H = 340, VH = 64;
  const iv = $derived(minutes * 60_000);
  const tr = (p: number) => (log ? Math.log(Math.max(p, 1)) : p);
  const inv = (y: number) => (log ? Math.exp(y) : y);
  const bounds = $derived(candles.length ? { from: candles[0]!.time, to: candles.at(-1)!.time + iv, minSpan: 10 * iv } : { from: 0, to: 1, minSpan: 1 });

  /** The first candle that ends after t. */
  function firstAfter(t: number) {
    let lo = 0, hi = candles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candles[mid]!.time + iv <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** The candle t falls into, or -1 when t is in a gap or outside. */
  function candleAt(t: number) {
    const i = firstAfter(t);
    return i < candles.length && candles[i]!.time <= t ? i : -1;
  }
  /** The value range for a time span: the candles in it, and the price held over a gap. */
  function fitY(x0: number, x1: number): { y0: number; y1: number } {
    let lo = Infinity, hi = 0;
    const from = Math.max(0, firstAfter(x0) - 1);
    for (let i = from; i < candles.length && candles[i]!.time < x1; i++) [lo, hi] = [Math.min(lo, Number(candles[i]!.low)), Math.max(hi, Number(candles[i]!.high))];
    if (hi === 0) return { y0: 0, y1: 1 };
    lo = Math.max(lo, 1); // a price of 0 has no place on a log scale
    if (log) return { y0: Math.log(lo * 0.7), y1: Math.log(hi * 1.4) };
    return { y0: hi / lo > 20 ? 0 : lo * 0.98, y1: hi * 1.04 };
  }

  // What is shown: null follows the data (everything, values fitted); zooming or dragging sets it. New candles show everything again.
  let manual = $derived((void candles, void log, null as View | null));
  const cur = $derived(manual ?? { x0: bounds.from, x1: bounds.to, ...fitY(bounds.from, bounds.to) });
  $effect(() => {
    view = candles.length && cur.x1 - cur.x0 < bounds.to - bounds.from - 1 ? { from: Math.floor(cur.x0), to: Math.ceil(cur.x1) - 1 } : null;
  });

  let hover = $state<number | null>(null); // the time under the pointer
  let box = $state<HTMLDivElement>();

  /** "4 Nov 2026, 10:21:07" taken apart; day candles are UTC days, so they are named in UTC. */
  function when(ms: number) {
    const [date, clock] = time(ms, minutes >= 1440).split(', ') as [string, string];
    return { date, day: date.replace(/ \d+$/, ''), clock: clock.slice(0, 5) };
  }
  /** Axis labels: whole dollars from $100 on. */
  const axis = (v: number) => (v >= 10_000 ? '$' + count(Math.round(v / 100)) : money(BigInt(Math.round(Math.max(0, v)))));

  const draw = $derived.by(() => {
    if (!candles.length) return null;
    const { x0, x1, y0, y1 } = cur;
    const X = (t: number) => ((t - x0) / (x1 - x0)) * W;
    const Y = (p: number) => ((y1 - tr(p)) / (y1 - y0)) * H;
    const f = (v: number) => v.toFixed(1);
    const slot = (iv / (x1 - x0)) * W, bw = slot * 0.6;
    const first = firstAfter(x0);
    let last = first;
    while (last < candles.length && candles[last]!.time < x1) last++;
    let vmax = 0;
    for (let i = first; i < last; i++) vmax = Math.max(vmax, candles[i]!.volume);
    let up = '', down = '', wickUp = '', wickDown = '', vol = '', gaps = '', line = '', pen = 'M';
    // A gap ends at the next candle's open: the price did not move while no prices were made.
    for (let i = Math.max(1, first); i <= Math.min(last, candles.length - 1); i++) {
      const a = candles[i - 1]!, b = candles[i]!;
      if (b.time > a.time + iv) gaps += `M${f(X(a.time + iv))} ${f(Y(Number(b.open)))}H${f(X(b.time))}`;
    }
    for (let i = first; i < last; i++) {
      const c = candles[i]!, cx = X(c.time + iv / 2), x = cx - bw / 2, o = Number(c.open), cl = Number(c.close ?? c.open);
      const top = Math.min(Y(o), Y(cl)), h = Math.max(1.5, Math.abs(Y(o) - Y(cl)));
      const body = `M${f(x)} ${f(top)}h${f(bw)}v${f(h)}h-${f(bw)}Z`, wick = `M${f(cx)} ${f(Y(Number(c.high)))}V${f(Y(Number(c.low)))}`;
      if (cl >= o) (up += body), (wickUp += wick);
      else (down += body), (wickDown += wick);
      const vh = vmax > 0 ? Math.max(1, Math.sqrt(c.volume / vmax) * VH) : 0;
      if (vh) vol += `M${f(x)} ${VH}v-${f(vh)}h${f(bw)}v${f(vh)}Z`;
      // The usual price: a line through one point per candle, broken where it is not known. Points far off are pulled to the edge.
      const u = usual?.[i];
      if (u === null || u === undefined) pen = 'M';
      else (line += `${pen}${f(cx)} ${f(Math.min(2 * H, Math.max(-H, Y(Number(u)))))}`), (pen = 'L');
    }
    let ticks: number[] = [];
    if (log) for (let e = Math.ceil(y0 / Math.LN10); e <= Math.floor(y1 / Math.LN10); e++) ticks.push(e * Math.LN10);
    if (ticks.length < 3 || ticks.length > 8) ticks = [0, 1, 2, 3, 4].map((k) => y0 + ((y1 - y0) * (k + 0.5)) / 5);
    const pct = (px: number, of: number) => `${((px / of) * 100).toFixed(2)}%`;
    const span = x1 - x0;
    // A marker sits on the candle its time falls into, at the order's average price.
    const markers = marks.flatMap((m) => {
      if (m.time < x0 || m.time >= x1) return [];
      const i = candleAt(m.time), y = Y(Number(m.price));
      return y < 0 || y > H ? [] : [{ left: pct(X(i < 0 ? m.time : candles[i]!.time + iv / 2), W), top: y.toFixed(1) + 'px', buy: m.buy }];
    });
    return {
      up, down, wickUp, wickDown, vol, gaps, usual: line, markers, X,
      // Two thirds of a candle's body, between 10 and 30 px.
      markWidth: `clamp(10px, ${((bw * 2) / 3 / W * 100).toFixed(3)}%, 30px)`,
      grid: ticks.map((t) => `M0 ${f(((y1 - t) / (y1 - y0)) * H)}H${W}`).join(''),
      yticks: ticks.map((t) => ({ top: pct(((y1 - t) / (y1 - y0)) * H, H), label: axis(inv(t)) })),
      xticks: [0, 1, 2, 3, 4, 5].map((k) => {
        const t = x0 + (span * (k + 0.5)) / 6;
        return { left: pct(((k + 0.5) / 6) * W, W), label: span < 86_400_000 ? when(t).clock : when(t).day };
      }),
    };
  });

  // The candle under the pointer, else the newest one shown; between candles, the gap and its price.
  const readout = $derived.by(() => {
    if (!candles.length) return null;
    const t = hover ?? Math.min(cur.x1, bounds.to) - 1;
    const i = candleAt(t);
    if (i < 0) {
      const next = firstAfter(t);
      if (next === 0 || next >= candles.length) return null;
      const a = candles[next - 1]!, b = candles[next]!;
      return { gap: true as const, x: draw?.X(t) ?? 0, from: time(a.time + iv), to: time(b.time), price: money(b.open) };
    }
    const c = candles[i]!, w = when(c.time);
    return {
      gap: false as const, x: draw?.X(c.time + iv / 2) ?? 0,
      time: minutes >= 1440 ? w.date : `${w.date}, ${w.clock}`,
      open: money(c.open), high: money(c.high), low: money(c.low), close: c.close === null ? 'not known yet' : money(c.close),
      volume: countShort(c.volume), more: describe(c.time, c.time + iv),
    };
  });

  // ---- Pointer and keys ----
  let drag: { x: number; y: number } | null = null;
  const rect = () => box!.getBoundingClientRect();
  const relX = (e: MouseEvent) => Math.min(1, Math.max(0, (e.clientX - rect().left) / rect().width));
  function move(e: PointerEvent) {
    if (drag) {
      manual = pan(cur, e.clientX - drag.x, e.clientY - drag.y, rect().width, H, bounds);
      drag = { x: e.clientX, y: e.clientY };
    }
    hover = cur.x0 + relX(e) * (cur.x1 - cur.x0);
  }
  function key(e: KeyboardEvent) {
    if (e.key !== ' ') return;
    e.preventDefault(); // the page would scroll
    manual = e.ctrlKey ? null : { ...cur, ...fitY(cur.x0, cur.x1) };
  }
  $effect(() => {
    const el = box;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // the page would scroll, or zoom with Ctrl
      const ry = 1 - Math.min(1, Math.max(0, (e.clientY - rect().top) / H));
      manual = wheel(cur, e, relX(e), ry, bounds);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', key);
    return () => (el.removeEventListener('wheel', onWheel), el.removeEventListener('keydown', key));
  });
</script>

{#if readout}
  <div class="readout">
    {#if readout.gap}
      <span style="font-weight: 600; color: var(--text)">{readout.from} to {readout.to}</span>
      <span>No candle in the save: no prices were made, the price stayed at {readout.price}</span>
    {:else}
      <span style="font-weight: 600; color: var(--text)">{readout.time}</span>
      <span>Open {readout.open}</span>
      <span>High {readout.high}</span>
      <span>Low {readout.low}</span>
      <span>Close {readout.close}</span>
      <span>Volume {readout.volume}</span>
      {#if readout.more}<span style="color: var(--text)">{readout.more}</span>{/if}
    {/if}
  </div>
{/if}
{#if draw}
  <div class="chart">
    <div style="flex: 1 1 0; min-width: 0">
      <!-- The chart takes the wheel, drags, Space and Ctrl+Space itself. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="plot" bind:this={box} role="img" aria-label={label} tabindex="0"
        onpointermove={move}
        onpointerdown={(e) => {
          drag = { x: e.clientX, y: e.clientY };
          box!.setPointerCapture(e.pointerId);
          box!.focus();
        }}
        onpointerup={() => (drag = null)}
        onpointerleave={() => (drag ? null : (hover = null))}
      >
        <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true" style="height: {H}px">
          <path d={draw.grid} class="grid" />
          <path d={draw.usual} class="usual" />
          {#if hover !== null && readout}<path d="M{readout.x.toFixed(1)} 0V{H}" class="cross" />{/if}
          <path d={draw.gaps} class="gap" />
          <path d={draw.wickUp} class="wick" style="stroke: var(--up)" />
          <path d={draw.wickDown} class="wick" style="stroke: var(--down)" />
          <path d={draw.up} style="fill: var(--up)" />
          <path d={draw.down} style="fill: var(--down)" />
        </svg>
        {#each draw.markers as m, i (i)}
          <span class="mark" class:buy={m.buy} style="left: {m.left}; top: {m.top}; width: {draw.markWidth}"><i></i></span>
        {/each}
        <svg viewBox="0 0 {W} {VH}" preserveAspectRatio="none" aria-hidden="true" style="height: {VH}px; margin-top: 8px">
          <path d={draw.vol} class="vol" />
        </svg>
      </div>
      <div class="xaxis" aria-hidden="true">
        {#each draw.xticks as t (t.left)}<span style="left: {t.left}">{t.label}</span>{/each}
      </div>
    </div>
    <div class="yaxis" aria-hidden="true">
      <div style="position: relative; height: {H}px">
        {#each draw.yticks as t (t.top)}<span style="top: {t.top}">{t.label}</span>{/each}
      </div>
      <div style="height: {VH}px; margin-top: 8px; display: flex; align-items: flex-end">Volume</div>
    </div>
  </div>
{/if}

<style>
  .readout { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 16px; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--text2); }
  .chart { display: flex; gap: 12px; margin-top: 12px; }
  .plot { position: relative; overflow: hidden; cursor: crosshair; touch-action: none; user-select: none; border-radius: 4px; }
  .plot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plot svg { display: block; width: 100%; }
  .grid { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .usual { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 6 5; vector-effect: non-scaling-stroke; }
  .cross { fill: none; stroke: var(--text3); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .gap { fill: none; stroke: var(--text3); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .wick { fill: none; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .vol { fill: var(--text3); fill-opacity: 0.45; }
  /* A halo in the card's colour keeps a marker apart from the candle under it. */
  .mark { position: absolute; aspect-ratio: 10 / 9; transform: translate(-50%, -50%); pointer-events: none; filter: drop-shadow(0 0 1px var(--card)) drop-shadow(0 0 1px var(--card)); }
  .mark i { display: block; width: 100%; height: 100%; background: var(--sell); clip-path: polygon(0 0, 100% 0, 50% 100%); }
  .mark.buy i { background: var(--buy); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  .xaxis { position: relative; height: 16px; margin-top: 8px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .xaxis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .yaxis { flex: none; width: 72px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .yaxis span { position: absolute; left: 0; transform: translateY(-50%); white-space: nowrap; }
</style>

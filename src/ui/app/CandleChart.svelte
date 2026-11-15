<script lang="ts">
  // Candles with their volume below, a readout of the candle under the pointer, zoom with the wheel and pan by dragging.
  // Prices are bigints; only the drawing goes through a float.
  import type { Candle } from '../../shared/api.ts';
  import { count, countShort, money, time } from '../../shared/fmt.ts';

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
  // Which candles are shown: a window of `size` candles from `start`. New candles show all of them again.
  let start = $derived((void candles, 0));
  let size = $derived(candles.length);
  let hover = $state<number | null>(null);
  let box = $state<HTMLDivElement>();

  const shown = $derived(candles.slice(start, start + size));
  $effect(() => {
    const last = shown.at(-1);
    view = size < candles.length && last ? { from: shown[0]!.time, to: last.time + iv - 1 } : null;
  });

  /** "4 Nov 2026, 10:21:07" taken apart; day candles are UTC days, so they are named in UTC. */
  function when(ms: number) {
    const [date, clock] = time(ms, minutes >= 1440).split(', ') as [string, string];
    return { date, day: date.replace(/ \d+$/, ''), clock: clock.slice(0, 5) };
  }
  /** Axis labels: whole dollars from $100 on. */
  const axis = (v: number) => (v >= 10_000 ? '$' + count(Math.round(v / 100)) : money(BigInt(Math.round(v))));

  const draw = $derived.by(() => {
    const n = shown.length;
    if (n === 0) return null;
    let lo0 = Infinity, hi0 = 0, vmax = 0;
    for (const c of shown) [lo0, hi0, vmax] = [Math.min(lo0, Number(c.low)), Math.max(hi0, Number(c.high)), Math.max(vmax, c.volume)];
    lo0 = Math.max(lo0, 1); // a price of 0 has no place on a log scale
    let Y: (p: number) => number, ticks: number[] = [];
    if (log) {
      const a = Math.log(lo0 * 0.7), b = Math.log(hi0 * 1.4);
      Y = (p) => ((b - Math.log(Math.max(p, 1))) / (b - a)) * H;
      for (let e = Math.ceil(a / Math.LN10); e <= Math.floor(b / Math.LN10); e++) ticks.push(10 ** e);
      if (ticks.length < 3) ticks = [0, 1, 2, 3, 4].map((k) => Math.exp(a + ((b - a) * (k + 0.5)) / 5));
    } else {
      const lo = hi0 / lo0 > 20 ? 0 : lo0 * 0.98, hi = hi0 * 1.04;
      Y = (p) => ((hi - p) / (hi - lo)) * H;
      ticks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * (k + 0.5)) / 5);
    }
    const slot = W / n, bw = slot * 0.6, f = (v: number) => v.toFixed(1);
    let up = '', down = '', wickUp = '', wickDown = '', vol = '';
    shown.forEach((c, i) => {
      const cx = (i + 0.5) * slot, x = cx - bw / 2, o = Number(c.open), cl = Number(c.close ?? c.open);
      const top = Math.min(Y(o), Y(cl)), h = Math.max(1.5, Math.abs(Y(o) - Y(cl)));
      const body = `M${f(x)} ${f(top)}h${f(bw)}v${f(h)}h-${f(bw)}Z`, wick = `M${f(cx)} ${f(Y(Number(c.high)))}V${f(Y(Number(c.low)))}`;
      if (cl >= o) (up += body), (wickUp += wick);
      else (down += body), (wickDown += wick);
      const vh = vmax > 0 ? Math.max(1, Math.sqrt(c.volume / vmax) * VH) : 0;
      if (vh) vol += `M${f(x)} ${VH}v-${f(vh)}h${f(bw)}v${f(vh)}Z`;
    });
    // The usual price follows the market: a line through one point per shown candle, broken where it is not known.
    // Points far off the plot are pulled in to its edge; the svg clips them.
    let line = '', pen = 'M';
    for (let i = 0; i < n; i++) {
      const u = usual?.[start + i];
      if (u === null || u === undefined) (pen = 'M');
      else (line += `${pen}${f((i + 0.5) * slot)} ${f(Math.min(2 * H, Math.max(-H, Y(Number(u)))))}`), (pen = 'L');
    }
    const span = shown.at(-1)!.time + iv - shown[0]!.time, step = Math.max(1, Math.round(n / 6));
    const pct = (v: number) => `${((v / H) * 100).toFixed(2)}%`;
    const at = (i: number) => `${(((i + 0.5) / n) * 100).toFixed(2)}%`;
    // A marker sits on the candle its time falls into, at the order's average price.
    const markers = marks.flatMap((m) => {
      const i = shown.findIndex((c) => m.time >= c.time && m.time < c.time + iv);
      return i < 0 ? [] : [{ left: at(i), top: Math.min(H, Math.max(0, Y(Number(m.price)))).toFixed(1) + 'px', buy: m.buy }];
    });
    return {
      up, down, wickUp, wickDown, vol, markers, slot,
      // Two thirds of a candle's body (which is 0.6 of its slot), between 10 and 30 px.
      markWidth: `clamp(10px, ${(40 / n).toFixed(3)}%, 30px)`,
      grid: ticks.map((t) => `M0 ${f(Y(t))}H${W}`).join(''),
      usual: line,
      yticks: ticks.map((t) => ({ top: pct(Y(t)), label: axis(t) })),
      xticks: shown.flatMap((c, i) => (i % step === step >> 1 ? [{ left: at(i), label: span < 86_400_000 ? when(c.time).clock : when(c.time).day }] : [])),
    };
  });

  const picked = $derived(hover !== null && hover >= start && hover < start + size ? candles[hover]! : shown.at(-1));
  const readout = $derived.by(() => {
    const c = picked;
    if (!c) return null;
    const w = when(c.time);
    return {
      time: minutes >= 1440 ? w.date : `${w.date}, ${w.clock}`,
      open: money(c.open), high: money(c.high), low: money(c.low), close: c.close === null ? 'not known yet' : money(c.close),
      volume: countShort(c.volume), more: describe(c.time, c.time + iv),
    };
  });

  // ---- Pointer ----
  let drag: { x: number; start: number } | null = null;
  const rel = (e: MouseEvent) => {
    const r = box!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  function move(e: PointerEvent) {
    if (drag) {
      const shift = Math.round(((drag.x - e.clientX) / box!.getBoundingClientRect().width) * size);
      start = Math.min(candles.length - size, Math.max(0, drag.start + shift));
    }
    hover = start + Math.min(size - 1, Math.floor(rel(e) * size));
  }
  $effect(() => {
    const el = box;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); // the page would scroll instead
      const r = rel(e), anchor = start + r * size;
      const next = Math.min(candles.length, Math.max(Math.min(10, candles.length), Math.round(size * (e.deltaY > 0 ? 1.25 : 0.8))));
      start = Math.min(candles.length - next, Math.max(0, Math.round(anchor - r * next)));
      size = next;
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
</script>

{#if readout}
  <div class="readout">
    <span style="font-weight: 600; color: var(--text)">{readout.time}</span>
    <span>Open {readout.open}</span>
    <span>High {readout.high}</span>
    <span>Low {readout.low}</span>
    <span>Close {readout.close}</span>
    <span>Volume {readout.volume}</span>
    {#if readout.more}<span style="color: var(--text)">{readout.more}</span>{/if}
  </div>
{/if}
{#if draw}
  <div class="chart">
    <div style="flex: 1 1 0; min-width: 0">
      <div
        class="plot" bind:this={box} role="img" aria-label={label}
        onpointermove={move}
        onpointerdown={(e) => {
          drag = { x: e.clientX, start };
          box!.setPointerCapture(e.pointerId);
        }}
        onpointerup={() => (drag = null)}
        onpointerleave={() => (drag ? null : (hover = null))}
      >
        <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true" style="height: {H}px">
          <path d={draw.grid} class="grid" />
          <path d={draw.usual} class="usual" />
          {#if picked && hover !== null}<path d="M{((hover - start + 0.5) * draw.slot).toFixed(1)} 0V{H}" class="cross" />{/if}
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
  .plot { position: relative; cursor: crosshair; touch-action: none; user-select: none; }
  .plot svg { display: block; width: 100%; }
  .grid { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .usual { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 6 5; vector-effect: non-scaling-stroke; }
  .cross { fill: none; stroke: var(--text3); stroke-width: 1; vector-effect: non-scaling-stroke; }
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

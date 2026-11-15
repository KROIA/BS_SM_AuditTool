<script lang="ts">
  // Every item of an account in one chart, a step line each (a balance holds until the next snapshot), with a list on
  // the left to switch lines on and off, a search for that list, and zoom and pan as in StockMarket's chart (zoom.ts).
  // Money in dollars and items in pieces share one axis, so it is logarithmic: a few diamonds still show next to
  // millions. A line's bands are spans to shade while it is shown, [from, to] in epoch ms.
  import type { Point } from '../../shared/api.ts';
  import { countShort, time } from '../../shared/fmt.ts';
  import FilterList from './FilterList.svelte';
  import { pan, timeTick, wheel, type View } from './zoom.ts';

  export interface Series { id: number; name: string; points: Point[]; fmt: (raw: bigint) => string; bands: [number, number][] }
  let { series, label }: { series: Series[]; label: string } = $props();

  const W = 1000, H = 360;
  /** One hue per line, spread by the golden angle; the first line (money) takes the accent. */
  const color = (k: number) => (k === 0 ? 'var(--accent)' : `oklch(var(--series-l) 0.15 ${((k * 137.508) % 360).toFixed(1)})`);
  // Raw amounts are hundredths; the axis is log10(1 + value), so 0 has a place and large values read as powers of ten.
  const pos = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v)); // ponytail: a negative balance sits below 0 but gets no ticks of its own
  const tr = (raw: bigint) => pos(Number(raw) / 100);
  const inv = (y: number) => Math.sign(y) * (10 ** Math.abs(y) - 1);
  /** The step of 1, 2 or 5 times a power of ten at or above x. */
  const nice = (x: number) => { const p = 10 ** Math.floor(Math.log10(x)); return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= x)!; };

  let off = $state(new Set<string | number>());
  const colored = $derived(series.map((s, k) => ({ ...s, color: color(k) })));
  const on = $derived(colored.filter((s) => !off.has(s.id) && s.points.length));

  const bounds = $derived.by(() => {
    const t = series.flatMap((s) => (s.points.length ? [s.points[0]![0], s.points.at(-1)![0]] : []));
    const from = t.length ? Math.min(...t) : 0, to = t.length ? Math.max(...t) : 1;
    return { from, to: Math.max(to, from + 60_000), minSpan: 60_000 };
  });
  /** The value a series has at t: its last point at or before t, else none. */
  function at(points: Point[], t: number): bigint | null {
    let lo = 0, hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid]![0] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo ? points[lo - 1]![1] : null;
  }
  /** The value range of the lines shown over a span, with a little room. */
  function fitY(x0: number, x1: number): { y0: number; y1: number } {
    let lo = Infinity, hi = -Infinity;
    for (const s of on) {
      const first = at(s.points, x0);
      for (const v of first === null ? [] : [first]) [lo, hi] = [Math.min(lo, tr(v)), Math.max(hi, tr(v))];
      for (const [t, v] of s.points) if (t > x0 && t <= x1) [lo, hi] = [Math.min(lo, tr(v)), Math.max(hi, tr(v))];
    }
    if (lo === Infinity) return { y0: 0, y1: 1 };
    const pad = Math.max(0.05, (hi - lo) * 0.06);
    return { y0: Math.max(lo > 0 ? 0 : -Infinity, lo - pad), y1: hi + pad };
  }

  // What is shown: null follows the data; zooming or dragging sets it. Other data shows everything again; switching a
  // line keeps the view (Space fits the values to the lines now shown).
  let manual = $derived((void series, null as View | null));
  const cur = $derived(manual ?? { x0: bounds.from, x1: bounds.to, ...fitY(bounds.from, bounds.to) });
  let hover = $state<number | null>(null);
  let box = $state<HTMLDivElement>();

  const draw = $derived.by(() => {
    const { x0, x1, y0, y1 } = cur;
    const X = (t: number) => ((t - x0) / (x1 - x0)) * W, Y = (raw: bigint) => ((y1 - tr(raw)) / (y1 - y0)) * H;
    const f = (v: number) => Math.min(1e6, Math.max(-1e6, v)).toFixed(1);
    const lines = on.map((s) => {
      let d = `M${f(X(s.points[0]![0]))} ${f(Y(s.points[0]![1]))}`;
      for (const [t, v] of s.points.slice(1)) d += `H${f(X(t))}V${f(Y(v))}`;
      return { id: s.id, color: s.color, d: d + `H${f(X(bounds.to))}` };
    });
    // A band is at least 8 units wide, so a gap of one minute in a range of weeks still shows.
    const shade = on.flatMap((s) => s.bands).map(([a, b]) => {
      const mid = (X(a) + X(b)) / 2, half = Math.max(4, (X(b) - X(a)) / 2);
      return `M${f(mid - half)} 0H${f(mid + half)}V${H}H${f(mid - half)}Z`;
    }).join('');
    // 0 and the powers of ten when the span has room for them, else round steps. p: place on the axis, v: value.
    let ticks: { p: number; v: number }[] = [];
    for (let e = -1; e <= Math.floor(y1); e++) {
      const v = e < 0 ? 0 : 10 ** e, p = pos(v);
      if (p >= y0 && p <= y1) ticks.push({ p, v });
    }
    if (ticks.length > 7) ticks = ticks.filter((_, k) => k % Math.ceil(ticks.length / 6) === 0);
    if (ticks.length < 3) {
      const lo = inv(y0), hi = inv(y1), step = Math.max(1, nice((hi - lo) / 5));
      ticks = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push({ p: pos(v), v });
    }
    const top = (p: number) => ((y1 - p) / (y1 - y0)) * H;
    const span = x1 - x0;
    return {
      lines, shade, X,
      grid: ticks.map((t) => `M0 ${f(top(t.p))}H${W}`).join(''),
      yticks: ticks.map((t) => ({ top: `${((top(t.p) / H) * 100).toFixed(2)}%`, label: countShort(Math.round(t.v)) })),
      xticks: [0, 1, 2, 3, 4].map((k) => ({ left: `${(((k + 0.5) / 5) * 100).toFixed(2)}%`, label: timeTick(x0 + (span * (k + 0.5)) / 5, span) })),
    };
  });

  // Under the pointer, else at the end of what is shown: each line's value.
  const readout = $derived.by(() => {
    const t = hover ?? Math.min(cur.x1, bounds.to);
    return { when: time(t), values: on.flatMap((s) => { const v = at(s.points, t); return v === null ? [] : [{ id: s.id, name: s.name, color: s.color, text: s.fmt(v) }]; }) };
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
      el.focus({ preventScroll: true }); // so Space and Ctrl+Space work after zooming, without a click first
      const ry = 1 - Math.min(1, Math.max(0, (e.clientY - rect().top) / H));
      manual = wheel(cur, e, relX(e), ry, bounds);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('keydown', key);
    return () => (el.removeEventListener('wheel', onWheel), el.removeEventListener('keydown', key));
  });
</script>

<div class="wrap">
  <FilterList bind:off label="Items on the chart" find="Find an item on the chart" all={['Show all items', 'Hide all items']}
    entries={colored.map((s) => ({ id: s.id, name: s.name, color: s.color, disabled: s.points.length ? undefined : 'No balance snapshot in this time range' }))} />
  <div style="min-width: 0">
    <div class="readout">
      <span style="font-weight: 600; color: var(--text)">{readout.when}</span>
      {#each readout.values as v (v.id)}<span><span class="dot" style="--c: {v.color}" aria-hidden="true"></span>{v.name} {v.text}</span>{/each}
    </div>
    <div class="chart">
      <!-- The chart takes the wheel, drags, Space and Ctrl+Space itself. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="plot" bind:this={box} role="img" aria-label="{label} from {time(cur.x0)} to {time(cur.x1)}" tabindex="0"
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
          {#if draw.shade}<path d={draw.shade} class="band" />{/if}
          {#if hover !== null}<path d="M{draw.X(hover).toFixed(1)} 0V{H}" class="cross" />{/if}
          {#each draw.lines as l (l.id)}<path d={l.d} class="line" style="stroke: {l.color}" />{/each}
        </svg>
      </div>
      <div class="yaxis" aria-hidden="true">
        {#each draw.yticks as t (t.top)}<span style="top: {t.top}">{t.label}</span>{/each}
      </div>
    </div>
    <div class="xaxis" aria-hidden="true">
      {#each draw.xticks as t (t.left)}<span style="left: {t.left}">{t.label}</span>{/each}
    </div>
  </div>
</div>

<style>
  .wrap { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; margin-top: 16px; }
  .dot { flex: none; display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; background: var(--c); vertical-align: -1px; }
  .readout { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--text2); }
  .chart { display: flex; gap: 12px; margin-top: 12px; }
  .plot { flex: 1 1 0; min-width: 0; overflow: hidden; cursor: crosshair; touch-action: none; user-select: none; border-radius: 4px; }
  .plot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plot svg { display: block; width: 100%; }
  .grid { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .band { fill: var(--high); fill-opacity: 0.3; stroke: none; }
  .cross { fill: none; stroke: var(--text3); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .yaxis { position: relative; flex: none; width: 64px; height: 360px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .yaxis span { position: absolute; left: 0; transform: translateY(-50%); white-space: nowrap; }
  .xaxis { position: relative; height: 16px; margin: 8px 76px 0 0; font-size: 12px; line-height: 16px; color: var(--text3); }
  .xaxis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
</style>

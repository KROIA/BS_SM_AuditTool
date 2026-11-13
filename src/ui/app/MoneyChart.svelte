<script lang="ts">
  // Money over time as a step line (a balance holds until the next snapshot), a second line for total wealth, and
  // numbered events on the money line. Zoom with the wheel and pan by dragging, as on the market chart.
  import type { Point } from '../../shared/api.ts';
  import { moneyShort, time } from '../../shared/fmt.ts';

  interface Mark { n: number; time: number; label: string }
  let {
    money, wealth, marks, end, label, picked = $bindable(null), view = $bindable(null),
  }: {
    money: Point[];
    /** null hides the line. */
    wealth: Point[] | null;
    marks: Mark[];
    /** Where the time axis ends at the latest: the end of the time range or of the data. */
    end: number;
    label: string;
    /** The number of the picked event. */
    picked?: number | null;
    /** The time span shown while zoomed in; null when all of it is shown. */
    view?: { from: number; to: number } | null;
  } = $props();

  const W = 1000, H = 280, MIN_SPAN = 10 * 60_000;
  const x0 = $derived(money[0]?.[0] ?? 0);
  const x1 = $derived(Math.max(end, money.at(-1)?.[0] ?? 0, x0 + MIN_SPAN));
  // The span on screen; new data shows all of it again.
  let a = $derived((void money, x0));
  let b = $derived((void money, x1));
  let box = $state<HTMLDivElement>();

  $effect(() => {
    view = a > x0 || b < x1 ? { from: Math.round(a), to: Math.round(b) } : null;
  });

  /** The value at t: the last point at or before it. */
  function at(s: Point[], t: number): bigint | null {
    let v: bigint | null = null;
    for (const [x, y] of s) {
      if (x > t) break;
      v = y;
    }
    return v;
  }

  const draw = $derived.by(() => {
    if (money.length === 0) return null;
    const lines = [money, ...(wealth ? [wealth] : [])];
    // From 0, or from the lowest point when a line goes below it (the bank's wealth series can).
    let hi = 0, lo = 0;
    const see = (v: bigint) => ([hi, lo] = [Math.max(hi, Number(v)), Math.min(lo, Number(v))]);
    for (const s of lines) {
      const first = at(s, a);
      if (first !== null) see(first);
      for (const [x, y] of s) if (x > a && x <= b) see(y);
    }
    if (hi === lo) hi = lo + 100;
    const top = hi + (hi - lo) * 0.08;
    const X = (t: number) => ((t - a) / (b - a)) * W, Y = (v: number) => H - ((v - lo) / (top - lo)) * H, f = (v: number) => v.toFixed(1);
    const path = (s: Point[]) => {
      const first = at(s, a), inside = s.filter(([x]) => x > a && x <= b);
      const start = first !== null ? 0 : X(inside[0]?.[0] ?? b);
      if (first === null && inside.length === 0) return '';
      let d = `M${f(start)} ${f(Y(Number(first ?? inside[0]![1])))}`;
      for (const [x, y] of inside) d += ` H${f(X(x))} V${f(Y(Number(y)))}`;
      return d + ` H${W}`;
    };
    const line = path(money);
    const ticks = [...new Set([0, 1, 2, 3].map((k) => lo + (hi - lo) * (k / 3)).concat(lo < 0 ? [0] : []))];
    const span = b - a, day = (ms: number) => time(ms).split(',')[0]!.replace(/ \d{4}$/, ''), clock = (ms: number) => time(ms).split(', ')[1]!.slice(0, 5);
    return {
      line, wealth: wealth ? path(wealth) : '',
      area: line ? `${line} V${f(Y(0))} H${line.slice(1).split(' ')[0]} Z` : '',
      grid: ticks.filter((v) => v !== lo).map((v) => `M0 ${f(Y(v))}H${W}`).join(''),
      yticks: ticks.map((v) => ({ top: `${((Y(v) / H) * 100).toFixed(2)}%`, label: moneyShort(BigInt(Math.round(v))) })),
      xticks: [0.1, 0.3, 0.5, 0.7, 0.9].map((p) => {
        const t = a + span * p;
        return { left: `${p * 100}%`, label: span <= 86_400_000 ? clock(t) : span <= 4 * 86_400_000 ? `${day(t)}, ${clock(t)}` : day(t) };
      }),
      marks: marks.flatMap((m) => {
        if (m.time < a || m.time > b) return [];
        const v = at(money, m.time) ?? money[0]![1];
        return [{ ...m, left: `${((X(m.time) / W) * 100).toFixed(2)}%`, top: `${((Y(Number(v)) / H) * 100).toFixed(2)}%`, x: X(m.time) }];
      }),
    };
  });
  const guide = $derived(draw?.marks.find((m) => m.n === picked));

  // ---- Pointer ----
  let drag: { x: number; a: number; b: number } | null = null;
  const rel = (e: MouseEvent) => {
    const r = box!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  function move(e: PointerEvent) {
    if (!drag) return;
    const shift = ((drag.x - e.clientX) / box!.getBoundingClientRect().width) * (drag.b - drag.a);
    const s = Math.min(x1 - drag.b, Math.max(x0 - drag.a, shift));
    [a, b] = [drag.a + s, drag.b + s];
  }
  $effect(() => {
    const el = box;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); // the page would scroll instead
      const r = rel(e), anchor = a + r * (b - a);
      const span = Math.min(x1 - x0, Math.max(MIN_SPAN, (b - a) * (e.deltaY > 0 ? 1.25 : 0.8)));
      const from = Math.min(x1 - span, Math.max(x0, anchor - r * span));
      [a, b] = [from, from + span];
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });
</script>

{#if draw}
  <div class="chart">
    <div
      class="plot" bind:this={box} role="img" aria-label={label}
      onpointermove={move}
      onpointerdown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        drag = { x: e.clientX, a, b };
        box!.setPointerCapture(e.pointerId);
      }}
      onpointerup={() => (drag = null)}
    >
      <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" aria-hidden="true">
        <path d={draw.grid} class="grid" />
        <path d={draw.area} class="area" />
        <path d={draw.line} class="line" />
        <path d={draw.wealth} class="wealth" />
        {#if guide}<path d="M{guide.x.toFixed(1)} 0V{H}" class="guide" />{/if}
      </svg>
      {#each draw.marks as m (m.n)}
        <button type="button" class="mark" aria-pressed={m.n === picked} aria-label="Event {m.n}: {m.label}" style="left: {m.left}; top: {m.top}"
          onclick={() => (picked = m.n)}>{m.n}</button>
      {/each}
    </div>
    <div class="yaxis" aria-hidden="true">
      {#each draw.yticks as t (t.top)}<span style="top: {t.top}">{t.label}</span>{/each}
    </div>
  </div>
  <div class="xaxis" aria-hidden="true">
    {#each draw.xticks as t (t.left)}<span style="left: {t.left}">{t.label}</span>{/each}
  </div>
{/if}

<style>
  .chart { display: flex; gap: 12px; margin-top: 24px; }
  .plot { position: relative; flex: 1 1 0; min-width: 0; height: 280px; cursor: grab; touch-action: none; user-select: none; }
  .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .grid { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .area { fill: var(--accent); fill-opacity: 0.12; stroke: none; }
  .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .wealth { fill: none; stroke: var(--text); stroke-width: 1.75; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .guide { fill: none; stroke: var(--text3); stroke-width: 1; stroke-dasharray: 4 4; vector-effect: non-scaling-stroke; }
  .mark { position: absolute; width: 24px; height: 24px; margin: -12px 0 0 -12px; padding: 0; border-radius: 50%; border: 2px solid var(--card);
    display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--raised); color: var(--text); }
  .mark[aria-pressed='true'] { background: var(--accent); color: var(--onaccent); }
  .yaxis { position: relative; flex: none; width: 64px; height: 280px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .yaxis span { position: absolute; left: 0; transform: translateY(-50%); white-space: nowrap; }
  .xaxis { position: relative; height: 16px; margin: 10px 76px 0 0; font-size: 12px; line-height: 16px; color: var(--text3); }
  .xaxis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
</style>

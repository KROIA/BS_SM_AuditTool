<script lang="ts">
  // A value over time as a step line: a balance holds until the next snapshot. bands: spans to shade, [from, to] in epoch ms.
  import type { Point } from '../../shared/api.ts';
  import { time } from '../../shared/fmt.ts';

  let { points, label, fmt, bands = [] }: { points: Point[]; label: string; fmt: (raw: bigint) => string; bands?: [number, number][] } = $props();

  const W = 1000, H = 180;
  const chart = $derived.by(() => {
    const pts = points;
    let lo = 0n, hi = 0n;
    for (const [, v] of pts) [lo, hi] = [v < lo ? v : lo, v > hi ? v : hi];
    if (hi === lo) hi = lo + 100n;
    const x0 = pts[0]![0], x1 = Math.max(pts.at(-1)![0], x0 + 1);
    const at = (ms: number) => Math.min(W, Math.max(0, ((ms - x0) / (x1 - x0)) * W));
    const x = (ms: number) => at(ms).toFixed(1);
    const y = (v: bigint) => (H - (Number(v - lo) / Number(hi - lo)) * H).toFixed(1); // only the drawing goes through a float
    let line = `M0 ${y(pts[0]![1])}`;
    for (const [ms, v] of pts.slice(1)) line += ` H${x(ms)} V${y(v)}`;
    line += ` H${W}`;
    // A band is at least 8 units wide, so a gap of one minute in a range of weeks still shows.
    const shade = bands.map(([a, b]) => {
      const mid = (at(a) + at(b)) / 2, half = Math.max(4, (at(b) - at(a)) / 2);
      return `M${(mid - half).toFixed(1)} 0H${(mid + half).toFixed(1)}V${H}H${(mid - half).toFixed(1)}Z`;
    }).join('');
    return { line, area: `${line} V${y(lo < 0n ? 0n : lo)} H0 Z`, shade, top: fmt(hi), mid: fmt((hi + lo) / 2n), bottom: fmt(lo), from: time(x0), to: time(x1) };
  });
</script>

<div class="chart">
  <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="{label} from {chart.from} to {chart.to}">
    <path d="M0 0H{W}M0 {H / 2}H{W}M0 {H}H{W}" class="grid" />
    {#if chart.shade}<path d={chart.shade} class="band" />{/if}
    <path d={chart.area} class="area" />
    <path d={chart.line} class="line" />
  </svg>
  <div class="yaxis" aria-hidden="true">
    <span style="top: -8px">{chart.top}</span>
    <span style="top: {H / 2 - 8}px">{chart.mid}</span>
    <span style="top: {H - 8}px">{chart.bottom}</span>
  </div>
</div>
<div class="xaxis" aria-hidden="true"><span>{chart.from}</span><span>{chart.to}</span></div>

<style>
  .chart { display: flex; gap: 12px; margin-top: 20px; }
  .chart svg { flex: 1 1 0; min-width: 0; height: 180px; overflow: visible; }
  .grid { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .band { fill: var(--high); fill-opacity: 0.3; stroke: none; }
  .area { fill: var(--accent); fill-opacity: 0.12; stroke: none; }
  .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .yaxis { position: relative; flex: none; width: 88px; height: 180px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .yaxis span { position: absolute; left: 0; white-space: nowrap; }
  .xaxis { display: flex; justify-content: space-between; margin: 10px 100px 0 0; font-size: 12px; line-height: 16px; color: var(--text3); }
</style>

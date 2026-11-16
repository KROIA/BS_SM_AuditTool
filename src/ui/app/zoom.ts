// Zoom and pan of a chart as in StockMarket's own charts: the wheel zooms both axes around the pointer (Ctrl: the
// values only, Shift: the time only), dragging moves both, Space fits the values to what is shown, Ctrl+Space shows
// everything. x is time in epoch ms, y is in the chart's own units (a log chart passes logarithms).
import { time } from '../../shared/fmt.ts';

/** What the chart shows: x0..x1 left to right, y0..y1 bottom to top. */
export interface View { x0: number; x1: number; y0: number; y1: number }

/** How far one can go: the time the data covers, the shortest time span worth showing and, if set, the longest. */
export interface Bounds { from: number; to: number; minSpan: number; maxSpan?: number }

/** Keeps the time span inside the data and at least minSpan wide; the values are not bounded. */
export function clampX(v: View, b: Bounds): View {
  const full = b.to - b.from;
  const span = Math.min(full, b.maxSpan ?? full, Math.max(Math.min(b.minSpan, full), v.x1 - v.x0));
  const x0 = Math.min(b.to - span, Math.max(b.from, v.x0));
  return { ...v, x0, x1: x0 + span };
}

/**
 * One wheel step. rx, ry: where the pointer is, 0..1 from the left and from the bottom; that point stays put.
 * Up zooms in by 10 %, down zooms out by 10 %, as in the game.
 */
export function wheel(v: View, e: { deltaX: number; deltaY: number; ctrlKey: boolean; shiftKey: boolean }, rx: number, ry: number, b: Bounds): View {
  const delta = e.deltaY || e.deltaX; // Shift turns the wheel sideways in Chromium
  if (!delta) return v;
  const f = delta < 0 ? 0.9 : 1.1;
  let { x0, x1, y0, y1 } = v;
  if (!e.ctrlKey) {
    // Zooming in stops at the shortest span around the pointer; leaving that to clampX would slide the view sideways.
    // Zooming out stops at the longest span the same way.
    const ax = x0 + rx * (x1 - x0), k = Math.min(Math.max(f, Math.min(b.minSpan, b.to - b.from) / (x1 - x0)), (b.maxSpan ?? Infinity) / (x1 - x0));
    [x0, x1] = [ax - (ax - x0) * k, ax + (x1 - ax) * k];
  }
  if (!e.shiftKey) {
    const ay = y0 + ry * (y1 - y0);
    [y0, y1] = [ay - (ay - y0) * f, ay + (y1 - ay) * f];
  }
  return clampX({ x0, x1, y0, y1 }, b);
}

/** A drag by dx, dy pixels on a plot of width w and height h: the content follows the pointer. */
export function pan(v: View, dx: number, dy: number, w: number, h: number, b: Bounds): View {
  const sx = (dx / w) * (v.x1 - v.x0), sy = (dy / h) * (v.y1 - v.y0);
  return clampX({ x0: v.x0 - sx, x1: v.x1 - sx, y0: v.y0 + sy, y1: v.y1 + sy }, b);
}

/** A time axis label for t when span ms are shown: the clock with milliseconds within ten seconds, with seconds within ten
 *  minutes, without them within a day, day and clock up to four days, else the day. */
export function timeTick(t: number, span: number, utc = false): string {
  const [date, clock] = time(t, utc).split(', ') as [string, string], day = date.replace(/ \d{4}$/, '');
  if (span <= 10_000) return `${clock}.${String(Math.floor(t) % 1000).padStart(3, '0')}`;
  if (span <= 600_000) return clock;
  return span <= 86_400_000 ? clock.slice(0, 5) : span <= 4 * 86_400_000 ? `${day}, ${clock.slice(0, 5)}` : day;
}

/** The labels of a time axis, ticks oldest first: timeTick for each, and when that leaves the day out, the day on the
 *  first label and on each label where a new day starts. */
export function timeTicks(ticks: number[], span: number, utc = false): string[] {
  const dayOf = (t: number) => time(t, utc).split(', ')[0]!.replace(/ \d{4}$/, '');
  return ticks.map((t, i) => {
    const label = timeTick(t, span, utc);
    return span > 86_400_000 || (i > 0 && dayOf(ticks[i - 1]!) === dayOf(t)) ? label : `${dayOf(t)}, ${label}`;
  });
}

export const HINT = 'Scroll to zoom (Ctrl: values only, Shift: time only), drag to move, Space fits the values to what is shown, Ctrl+Space shows everything.';

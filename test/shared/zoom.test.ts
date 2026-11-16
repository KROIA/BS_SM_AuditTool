import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampX, pan, timeTick, timeTicks, wheel } from '../../src/ui/app/zoom.ts';

const B = { from: 0, to: 1000, minSpan: 50 };
const V = { x0: 0, x1: 1000, y0: 0, y1: 100 };
const up = { deltaX: 0, deltaY: -100, ctrlKey: false, shiftKey: false };

test('the wheel zooms both axes around the pointer; Ctrl only the values, Shift only the time', () => {
  assert.deepEqual(wheel(V, up, 0.5, 0.5, B), { x0: 50, x1: 950, y0: 5, y1: 95 });
  assert.deepEqual(wheel(V, up, 0, 0, B), { x0: 0, x1: 900, y0: 0, y1: 90 }); // the point under the pointer stays put
  assert.deepEqual(wheel(V, { ...up, ctrlKey: true }, 0.5, 0.5, B), { x0: 0, x1: 1000, y0: 5, y1: 95 });
  // Shift turns the wheel sideways: deltaX carries it.
  assert.deepEqual(wheel(V, { deltaX: -100, deltaY: 0, ctrlKey: false, shiftKey: true }, 0.5, 0.5, B), { x0: 50, x1: 950, y0: 0, y1: 100 });
  // Zooming out stops at the data, zooming in at the shortest span.
  assert.deepEqual(wheel(V, { ...up, deltaY: 100 }, 0.5, 0.5, B).x1 - wheel(V, { ...up, deltaY: 100 }, 0.5, 0.5, B).x0, 1000);
  assert.equal(clampX({ ...V, x0: 500, x1: 510 }, B).x1 - clampX({ ...V, x0: 500, x1: 510 }, B).x0, 50);
  // At the shortest span the time stays put, and the last step in keeps the point under the pointer: no sideways slide.
  const at = { ...V, x0: 100, x1: 150 }, near = wheel({ ...V, x0: 100, x1: 155 }, up, 0.5, 0.5, B);
  assert.deepEqual(wheel(at, { ...up, shiftKey: true }, 0.2, 0.5, B), at);
  assert.ok(Math.abs(near.x1 - near.x0 - 50) < 1e-9 && Math.abs(near.x0 + near.x1 - 255) < 1e-9);
});

test('dragging moves the content with the pointer and stays inside the data in time', () => {
  const v = { x0: 200, x1: 400, y0: 0, y1: 100 };
  assert.deepEqual(pan(v, 100, 50, 1000, 500, B), { x0: 180, x1: 380, y0: 10, y1: 110 });
  assert.deepEqual(pan(v, 10_000, 0, 1000, 500, B), { x0: 0, x1: 200, y0: 0, y1: 100 });
});

test('time axis labels say as much as the span shown needs', () => {
  const t = Date.UTC(2026, 10, 4, 11, 30, 15), MIN = 60_000, DAY = 86_400_000;
  assert.equal(timeTick(t + 42, 1_000, true), '11:30:15.042');
  assert.equal(timeTick(t, MIN, true), '11:30:15');
  assert.equal(timeTick(t, DAY, true), '11:30');
  assert.equal(timeTick(t, 2 * DAY, true), '4 Nov, 11:30');
  assert.equal(timeTick(t, 30 * DAY, true), '4 Nov');
});

test('a short time axis names the day on its first label and where a new day starts', () => {
  const H = 3_600_000, t = Date.UTC(2026, 10, 4, 22, 0);
  assert.deepEqual(timeTicks([t, t + H, t + 2 * H, t + 3 * H], 4 * H, true), ['4 Nov, 22:00', '23:00', '5 Nov, 00:00', '01:00']);
  assert.deepEqual(timeTicks([t, t + 2 * 86_400_000], 3 * 86_400_000, true), ['4 Nov, 22:00', '6 Nov, 22:00']); // long axes name every day already
});

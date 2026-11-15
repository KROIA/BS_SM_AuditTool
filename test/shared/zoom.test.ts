import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampX, pan, wheel } from '../../src/ui/app/zoom.ts';

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
});

test('dragging moves the content with the pointer and stays inside the data in time', () => {
  const v = { x0: 200, x1: 400, y0: 0, y1: 100 };
  assert.deepEqual(pan(v, 100, 50, 1000, 500, B), { x0: 180, x1: 380, y0: 10, y1: 110 });
  assert.deepEqual(pan(v, 10_000, 0, 1000, 500, B), { x0: 0, x1: 200, y0: 0, y1: 100 });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Mark, type Point, type Scope } from '../../src/shared/api.ts';
import { ACCOUNT_ORDER, buildFixtures, CHECK, STRAY, T0, WEALTH_SNAPS, type Fixtures } from '../fixtures/build.ts';

const ALL: Scope = { from: null, to: null, server: null };
const MIN = 60_000;
const mark = (part: Partial<Mark>): Mark => ({ title: 'A finding', start: T0, pinned: false, dismissed: false, reason: '', note: '', ...part });
/** The value of a carried-forward series at time t: its last point at or before t. */
const at = (s: Point[], t: number) => s.filter(([x]) => x <= t).at(-1)?.[1] ?? 0n;
let fx: Fixtures;

before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-overview-')));
  init(path.join(fx.root, 'workspace'));
  addSave(fx.master);
});
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('overview: money is every account\'s own series added up, with each one\'s last value carried forward', () => {
  const o = api.overview(ALL);
  const money = api.items().filter((i) => i.money).map((i) => i.id);
  const accounts = [...ACCOUNT_ORDER, ...Object.values(CHECK), STRAY.account];
  const own = accounts.flatMap((a) => money.map((m) => api.balances(a, m, ALL)));
  assert.ok(o.money.length > 20);
  for (const [t, v] of o.money) assert.equal(v, own.reduce((sum, s) => sum + at(s, t), 0n), `minute ${(t - T0) / MIN}`);
  // A range starts with the value carried in from before it.
  const scope: Scope = { from: T0 + 25 * MIN, to: T0 + 60 * MIN, server: null };
  const part = api.overview(scope).money;
  assert.deepEqual(part[0], [scope.from, at(o.money, scope.from!)]);
  assert.ok(part.every(([t]) => t >= scope.from! && t <= scope.to!));
  assert.equal(part.at(-1)![1], at(o.money, scope.to!));
});

test('overview: total wealth sums the bank\'s series, the company account once, last values carried forward', () => {
  const company = WEALTH_SNAPS[1][2];
  assert.deepEqual(api.overview(ALL).wealth, [[T0, 60_000_000n], [T0 + 10 * MIN, 60_000_000n + company], [T0 + 30 * MIN, 600_000_000n + company]]);
});

test('overview: the top players made a profit, the unusual markets went at least twice their usual price', () => {
  const o = api.overview(ALL);
  assert.deepEqual(o.top.map((p) => p.name), ['Tavrik', 'Quenby']);
  assert.deepEqual(o.top, api.players(ALL).filter((p) => p.profit > 0n));
  assert.deepEqual(o.unusual.map((m) => [m.item, m.usual, m.below]), [[2, 5270n, false], [3, 3009n, false]]);
  for (const m of o.unusual) {
    const row = api.markets(ALL).find((x) => x.item === m.item)!;
    assert.deepEqual([m.low, m.high], [row.low, row.high]);
    assert.equal(m.times, Number(m.high) / Number(m.usual));
  }
});

test('key events: open incidents, the largest gaps outside them and the largest admin actions, oldest first', () => {
  const list = () => api.keyEvents(ALL, DEFAULT_RULES).map((e) => `${e.kind} ${(e.time - T0) / MIN}`);
  assert.deepEqual(list(), ['incident 0', 'gap 11', 'gap 31', 'incident 46', 'admin 120', 'admin 125', 'admin 128', 'admin 129']);
  // Short: the admin set of 10'000.00 at minute 30 is the third largest and left out.
  assert.equal(api.adminEvents(ALL).filter((a) => a.amount !== null).length, 3);
  // An incident whose findings are all marked "not a problem" leaves the chart.
  const first = api.incidents(ALL, DEFAULT_RULES).incidents[0]!;
  for (const id of first.findings) api.mark(id, mark({ dismissed: true }));
  try {
    assert.deepEqual(list(), ['gap 11', 'gap 31', 'incident 46', 'admin 120', 'admin 125', 'admin 128', 'admin 129']);
  } finally {
    for (const id of first.findings) api.mark(id, mark({}));
  }
});

test('overview: a save without the wealth series has no wealth line', () => {
  init(path.join(fx.root, 'legacy-workspace'));
  try {
    addSave(fx.legacy);
    const o = api.overview(ALL);
    assert.equal(o.wealth, null);
    assert.ok(o.money.length > 0);
  } finally {
    init(path.join(fx.root, 'workspace'));
  }
});

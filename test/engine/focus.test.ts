import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, type Fixtures } from '../fixtures/build.ts';

const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;

before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-focus-')));
  init(path.join(fx.root, 'workspace'));
  addSave(fx.master);
  for (const s of fx.slaves) addSave(s);
});
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test("an incident's focus: only its players, accounts, findings and markets; everything whole again without it", () => {
  const whole = () => JSON.stringify([api.players(ALL), api.accounts(ALL, DEFAULT_RULES), api.findings(ALL, DEFAULT_RULES).findings.map((f) => f.id),
    api.markets(ALL), api.orders({}, ALL).length, api.overview(ALL)], (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
  const before = whole();
  const inc = api.incidents(ALL, DEFAULT_RULES).incidents[0]!;
  const focus: Scope = { ...ALL, focus: inc };
  const players = new Set(inc.players.map((p) => p.uuid));
  const accounts = new Set([...inc.accounts, ...api.accounts(ALL, DEFAULT_RULES).filter((a) => a.owner !== null && players.has(a.owner)).map((a) => a.number)]);

  assert.deepEqual(new Set(api.players(focus).map((p) => p.uuid)), players);
  assert.deepEqual(new Set(api.accounts(focus, DEFAULT_RULES).map((a) => a.number)), accounts);
  const orders = api.orders({}, focus);
  assert.ok(orders.length > 0 && orders.length < api.orders({}, ALL).length);
  assert.ok(orders.every((o) => players.has(o.player) || accounts.has(o.account)));
  assert.ok(api.ledger({}, focus).every((r) => accounts.has(r.account)));
  assert.deepEqual(api.findings(focus, DEFAULT_RULES).findings.map((f) => f.id).sort(), [...inc.findings].sort());
  assert.deepEqual(api.incidents(focus, DEFAULT_RULES).incidents.map((i) => i.id), [inc.id]);
  assert.ok(api.markets(focus).every((m) => m.orders > 0) && api.markets(focus).length < api.markets(ALL).length);
  // Names come from the whole tables: the same as without the focus.
  const owners = new Map(api.accounts(ALL, DEFAULT_RULES).map((a) => [a.number, a.ownerName]));
  assert.ok(api.accounts(focus, DEFAULT_RULES).every((a) => a.ownerName === owners.get(a.number)));

  assert.equal(whole(), before); // nothing kept per connection leaked from one into the other
});

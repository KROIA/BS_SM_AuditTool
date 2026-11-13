import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { suspicion } from '../../src/engine/query/incidents.ts';
import { addSave, CASE_LIMIT, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Mark, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const ALL: Scope = { from: null, to: null, server: null };
const mark = (part: Partial<Mark>): Mark => ({ title: 'A finding', start: T0, pinned: false, dismissed: false, reason: '', note: '', ...part });
let fx: Fixtures;
let dir: string;
const file = () => path.join(dir, 'case.json');
const restart = () => (init(dir), api.workspace());

before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-case-')));
  dir = path.join(fx.root, 'workspace');
  init(dir);
  addSave(fx.master);
});
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('case.json: marks and rule settings survive a restart, an empty mark is removed', () => {
  api.mark('bank-flag:3', mark({ pinned: true, note: 'Seen in the log' }));
  api.mark('bank-flag:2', mark({ dismissed: true, reason: 'An admin test' }));
  api.setRules({ ...DEFAULT_RULES, 'order-rate': { on: false, orders: 7 }, 'hour-profit': { on: true, money: 123_456_789_012_345n } });
  api.mark('gone', mark({ pinned: true }));
  api.mark('gone', mark({})); // nothing left to keep
  restart();
  const c = api.caseData();
  assert.deepEqual(c.marks, { 'bank-flag:3': mark({ pinned: true, note: 'Seen in the log' }), 'bank-flag:2': mark({ dismissed: true, reason: 'An admin test' }) });
  assert.deepEqual(c.rules['order-rate'], { on: false, orders: 7 });
  assert.equal(c.rules['hour-profit'].money, 123_456_789_012_345n);
  assert.equal(api.workspace().saves.length, 1); // the save folders are kept beside them
  assert.ok(!fs.existsSync(file() + '.tmp'));
  api.setRules(DEFAULT_RULES);
  for (const id of Object.keys(c.marks)) api.mark(id, mark({}));
});

test('case.json: invalid fields fall back to their defaults, bad marks are dropped', () => {
  fs.writeFileSync(file(), JSON.stringify({
    saves: [fx.master, 5],
    rules: { 'order-rate': { on: 'yes', orders: -3 }, 'far-price': { on: false, times: 'x' }, 'hour-profit': { money: '12.5' }, 'balance': { money: '500' }, 'made-up': { on: true } },
    marks: { a: { pinned: true, start: 'soon', note: 7 }, b: 'pinned', c: { pinned: 'true' }, ['x'.repeat(501)]: { pinned: true } },
  }));
  restart();
  const c = api.caseData();
  assert.deepEqual(c.rules['order-rate'], DEFAULT_RULES['order-rate']);
  assert.deepEqual(c.rules['far-price'], { on: false, times: 10 });
  assert.equal(c.rules['hour-profit'].money, DEFAULT_RULES['hour-profit'].money);
  assert.equal(c.rules.balance.money, 500n);
  assert.ok(!('made-up' in c.rules));
  assert.deepEqual(c.marks, { a: mark({ title: '', start: 0, pinned: true }) });
  assert.equal(api.workspace().saves.length, 1);
});

test('case.json: a broken or oversized file is kept as case.json.broken and the case starts empty', () => {
  for (const content of ['{"marks": {"a": {"pinned": tr', '{"marks":{}}' + ' '.repeat(CASE_LIMIT)]) {
    fs.rmSync(file() + '.broken', { force: true });
    fs.writeFileSync(file(), content);
    restart();
    assert.deepEqual(api.caseData(), { rules: DEFAULT_RULES, marks: {} });
    assert.equal(fs.readFileSync(file() + '.broken', 'utf8'), content);
    api.mark('a', mark({ pinned: true })); // the next write replaces the broken file
    assert.equal(JSON.parse(fs.readFileSync(file(), 'utf8')).marks.a.pinned, true);
    api.mark('a', mark({}));
  }
  addSave(fx.master); // the empty case forgot it
});

test('orphans: a pinned finding the rules no longer raise is reported with its stored mark', () => {
  const id = `hour-profit:${uuidText(PLAYERS.Tavrik.n)}@${T0}`;
  api.mark(id, mark({ pinned: true, title: 'Profit in one hour' }));
  assert.deepEqual(api.incidents(ALL, DEFAULT_RULES).orphans, []);
  const higher = { ...DEFAULT_RULES, 'hour-profit': { on: true, money: 1_000_000_000n } }; // $10M, Tavrik made $5.44M
  const r = api.incidents(ALL, higher);
  assert.deepEqual(r.orphans, [id]);
  assert.ok(!r.incidents.some((i) => i.findings.includes(id)));
  assert.equal(api.caseData().marks[id]?.title, 'Profit in one hour');
  api.mark(id, mark({}));
});

test('suspicion leaves out the findings the case marks as not a problem', () => {
  const list = api.findings(ALL, DEFAULT_RULES).findings;
  const lost = list.find((x) => x.id.startsWith('bank-flag:log@'))!.id; // Quenby's critical flag
  const quenby = uuidText(PLAYERS.Quenby.n);
  assert.equal(suspicion(list).get(quenby), 12);
  api.mark(lost, mark({ dismissed: true }));
  assert.equal(suspicion(list).get(quenby), 4);
  api.mark(lost, mark({}));
});

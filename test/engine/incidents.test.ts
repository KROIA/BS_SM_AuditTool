import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { join, suspicion } from '../../src/engine/query/incidents.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Finding, type Incident, type Scope } from '../../src/shared/api.ts';
import { time } from '../../src/shared/fmt.ts';
import { incidentSentence, incidentTitle } from '../../src/shared/incident.ts';
import { AUDIT_OFFSET, buildFixtures, ITEM, LOST_FLAG, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const at = (minute: number) => T0 + minute * MIN;
let fx: Fixtures;

before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-incidents-')));
  init(path.join(fx.root, 'workspace'));
  addSave(fx.master);
});
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

/** A finding with only what the grouping reads. */
const f = (id: string, start: number, end: number, players: string[], markets: number[] = [], accounts: number[] = []): Finding => ({
  id, rule: 'far-price', level: 'medium', basis: 'proven', source: 'tool', start: at(start), end: at(end),
  players: players.map((uuid) => ({ uuid, name: uuid })), markets, accounts, servers: [],
  measured: { value: 1, threshold: null, unit: 'times' }, facts: {}, records: { orders: [], ledger: [], flags: [], candles: [] }, acknowledged: null,
});
const ids = (list: Finding[], owner = new Map<number, string>()) => join(list, owner).map((g) => g.list.map((x) => x.id)).sort();

test('join: a shared player or a shared market less than 30 minutes apart', () => {
  assert.deepEqual(ids([f('a', 0, 10, ['p']), f('b', 39, 40, ['p'])]), [['a', 'b']]); // 29 minutes from end to start
  assert.deepEqual(ids([f('a', 0, 10, [], [2]), f('b', 39, 40, ['q'], [2])]), [['a', 'b']]);
  assert.deepEqual(ids([f('a', 0, 10, ['p'], [2]), f('b', 5, 6, ['q'], [3])]), [['a'], ['b']]); // overlapping, nothing shared
});

test('join: 30 minutes apart or more stays apart', () => {
  assert.deepEqual(ids([f('a', 0, 10, ['p'], [2]), f('b', 40, 41, ['p'], [2])]), [['a'], ['b']]);
  assert.deepEqual(ids([f('a', 50, 60, ['p']), f('b', 0, 20, ['p'])]), [['a'], ['b']]);
});

test('join: a chain needs the repeat, and a finding with only an account joins through the owner', () => {
  // b shares nothing with a and lies 50 minutes after it: it joins only once c (a's player, b's market) has joined a.
  const chain = [f('a', 0, 0, ['p']), f('b', 50, 50, ['q'], [2]), f('c', 20, 45, ['p'], [2])];
  assert.deepEqual(ids(chain), [['a', 'c', 'b']]); // oldest first
  const gap = [f('t', 0, 10, ['p']), f('balance', 20, 30, [], [], [11])];
  assert.deepEqual(ids(gap), [['balance'], ['t']]);
  assert.deepEqual(ids(gap, new Map([[11, 'p']])), [['t', 'balance']]);
});

test('incidents on the fixture: Tavrik on the diamond market and Quenby on the emerald market, the rest alone', () => {
  const r = api.incidents(ALL, DEFAULT_RULES);
  const tavrik = uuidText(PLAYERS.Tavrik.n);
  assert.deepEqual(r.incidents.map((i) => [i.id, i.level, i.players.map((p) => p.name), i.markets, i.findings.length, i.start, i.end]), [
    [`hour-profit:${tavrik}@${T0}`, 'high', ['Tavrik'], [ITEM.diamond], 6, T0, at(60) - 1],
    [`order-rate:${uuidText(PLAYERS.Quenby.n)}@${at(46)}`, 'medium', ['Quenby'], [ITEM.emerald], 2, at(46), r.incidents[1]!.end],
  ]);
  // The bank flag on Tavrik's account (45 minutes) is in; Quenby's lost flag (100 minutes) is 40 minutes after her incident.
  assert.ok(r.incidents[0]!.findings.includes('bank-flag:1'));
  assert.deepEqual(r.others.map((x) => x.id), ['bank-flag:3', `bank-flag:log@${LOST_FLAG.ts + AUDIT_OFFSET}:${LOST_FLAG.account}:${LOST_FLAG.type}`, 'balance:14:1@' + at(30), 'bank-flag:2', `order-ledger:${uuidText(PLAYERS.Brindle.n)}@${T0 + 301_200}`, 'balance:12:1@' + at(10), 'last-save:after-save']);
});

test('incidents: the realised profit of its players on its markets within its span', () => {
  const [tavrik, quenby] = api.incidents(ALL, DEFAULT_RULES).incidents;
  assert.equal(tavrik!.profit, 544_083_000n); // the same sales as the profit-per-hour finding
  assert.equal(quenby!.profit, 15_227_000n);
});

test('incidents follow the time range and the server filter like findings()', () => {
  const late = api.incidents({ ...ALL, from: at(61) }, DEFAULT_RULES);
  assert.deepEqual(late.incidents, []);
  assert.deepEqual(late.others.map((x) => x.id), api.findings({ ...ALL, from: at(61) }, DEFAULT_RULES).findings.map((x) => x.id));
  const mining = api.incidents({ ...ALL, server: 'mining-1' }, DEFAULT_RULES);
  assert.deepEqual(mining.incidents, []); // both were placed on the master
  assert.ok(mining.others.some((x) => x.rule === 'order-ledger'));
});

test('title and sentence: plain English, every number through fmt', () => {
  const name = (id: number) => (id === ITEM.diamond ? 'Diamond' : id === ITEM.emerald ? 'Emerald' : 'Iron ingot');
  const [tavrik] = api.incidents(ALL, DEFAULT_RULES).incidents;
  const day = time(T0).split(',')[0];
  assert.equal(incidentTitle(tavrik!, name), 'Tavrik on the diamond market');
  assert.equal(incidentSentence(tavrik!, name), `Tavrik made $5.44M on the diamond market within 60 minutes on ${day}. The incident holds 6 findings, the strongest of them high.`);

  const base: Incident = { ...tavrik!, players: [], markets: [ITEM.diamond, ITEM.emerald], profit: 0n, level: 'medium', findings: ['a', 'b'], start: T0, end: T0 + 27 * MIN };
  assert.equal(incidentTitle(base, name), 'The diamond and emerald markets');
  assert.equal(incidentSentence(base, name), `2 findings about the diamond and emerald markets within 27 minutes on ${day}. The strongest of them is medium.`);
  const crowd: Incident = { ...base, players: ['A', 'B', 'C'].map((n) => ({ uuid: n, name: n })), markets: [1, 2, 3], profit: -123_456_789_012n, end: T0 + 5 * 3_600_000 };
  assert.equal(incidentTitle(crowd, name), '3 players on 3 markets');
  assert.equal(incidentSentence(crowd, name), `3 players lost $1.23B on 3 markets within 5 hours on ${day}. The incident holds 2 findings, the strongest of them medium.`);
  assert.match(incidentSentence({ ...crowd, end: T0 + 3 * 86_400_000 }, name), /^3 players lost \$1\.23B on 3 markets between \d+ Nov 2026 and \d+ Nov 2026\./);
});

test('suspicion: 8, 4, 2, 1 per finding by level, dismissed findings left out', () => {
  const list = api.findings(ALL, DEFAULT_RULES).findings;
  const order = (s: Map<string, number>) => [...s].map(([uuid, n]) => [Object.entries(PLAYERS).find(([, p]) => uuidText(p.n) === uuid)![0], n] as const)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  // Tavrik also traded in the diamond spike's minute: named there, not counted.
  assert.deepEqual(order(suspicion(list)), [['Quenby', 12], ['Tavrik', 12], ['Ombrelune', 4], ['Brindle', 2], ['Mikko_82', 1]]);
  const lost = list.find((x) => x.id.startsWith('bank-flag:log@'))!.id; // Quenby's critical flag
  assert.deepEqual(order(suspicion(list, new Set([lost]))).slice(0, 3), [['Tavrik', 12], ['Ombrelune', 4], ['Quenby', 4]]);
});

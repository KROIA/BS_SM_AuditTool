// The cross-server check on the invented network: one transfer per class, the rule's findings, saves
// without a journal, and rows no mod writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { classify, IN_FLIGHT, readItems, type Pair } from '../../src/engine/query/transfers.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, ITEM, NOTE, PLAYERS, T0, TRANSFER_CASES, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const PLAIN = ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000003'];
let fx: Fixtures;
let n = 0;
const open = (...saves: string[]) => {
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of saves) addSave(s);
};
const network = () => open(fx.master, ...fx.slaves);
const id = (k: number) => TRANSFER_CASES[k - 4]!.id; // the cases start at id ...04

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-transfers-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('items_json: Gson\'s shape only, per item, amounts exact above 2^53, nothing reaches a prototype', () => {
  assert.deepEqual(readItems('{"1":1200000,"5":300}'), new Map([[1, 1_200_000n], [5, 300n]]));
  assert.deepEqual(readItems('{"1":9007199254740993}'), new Map([[1, 9_007_199_254_740_993n]]));
  assert.deepEqual(readItems('{}'), new Map());
  for (const bad of ['{"__proto__":1}', '{"1":1,}', '{"1":"5"}', '[1]', '{"1":1.5}', 'null', `{"1":${'9'.repeat(5000)}}`]) assert.equal(readItems(bad), null, bad);
  assert.equal(readItems(null), null);
});

test('without a journal: an empty result and a sentence, never an error', () => {
  open(fx.master);
  let r = api.transfers(ALL);
  assert.deepEqual([r.transfers, r.reason], [[], 'No slave save is loaded. Every transfer is written down in a slave\'s journal, so add the slaves to check them.']);
  assert.equal(api.findings(ALL, DEFAULT_RULES).rules.find((s) => s.rule === 'transfer')!.notApplicable, r.reason);
  open(fx.legacy);
  r = api.transfers(ALL);
  assert.equal(r.transfers.length, 0);
  assert.match(r.reason!, /^No slave save is loaded\./);
  open(fx.slaves[0]!);
  assert.equal(api.transfers(ALL).reason, 'No save with bank data is loaded, so no transfer can be checked.');
});

test('every class is found, paired by id alone', () => {
  network();
  const r = api.transfers(ALL);
  assert.equal(r.reason, null);
  const cls = Object.fromEntries(r.transfers.map((t) => [t.id, t.class]));
  for (const c of TRANSFER_CASES) {
    if (c.class === 'ignored') assert.equal(cls[c.id], undefined, c.id);
    else assert.equal(cls[c.id], c.class, c.id);
  }
  for (const p of PLAIN) assert.equal(cls[p], 'ok');
  assert.deepEqual(r.counts, { 'ok': 7, 'parked': 1, 'twice': 2, 'lost': 1, 'created': 1, 'known-gap': 1, 'data-gap': 2, 'after-snapshot': 2 });
  assert.ok(r.transfers.every((t, i) => i === 0 || r.transfers[i - 1]!.start >= t.start)); // newest first

  const get = (k: number) => r.transfers.find((t) => t.id === id(k))!;
  const money = (sent: bigint, received: bigint) => [{ item: null, sent, received }];
  assert.deepEqual([get(4).items, get(4).steps], [money(300_000n, 300_000n), ['REQUESTED', 'CONFIRMED', 'RETURNED']]); // the returned part is not sent
  // Debit less refund = delivered: the 100 $ notes of the journal and the master's money item are both money.
  assert.deepEqual([get(6).items, get(6).path, get(6).ledger.length], [money(300_000n, 300_000n), 'DROP', 2]);
  assert.deepEqual([get(9).items, get(9).ledger.length], [money(70_000n, 140_000n), 2]);
  // Same raw amount, another item: per item, the iron did not arrive and the diamonds came from nowhere.
  assert.deepEqual(get(17).items, [{ item: ITEM.diamond, sent: 0n, received: 50_000n }, { item: ITEM.iron, sent: 50_000n, received: 0n }]);
  assert.equal(get(17).class, 'twice');
  assert.deepEqual([get(14).server, get(14).direction, get(14).player?.name], [null, null, 'Mikko_82']); // only on the master
  assert.deepEqual([get(8).server, get(8).account, get(8).player?.name, get(8).items], ['mining-1', PLAYERS.AdmiralNoor.account, 'AdmiralNoor', money(250_000n, 0n)]);
});

test('the rule: one high, proven finding per lost, twice, created and parked transfer; their ok neighbours are not flagged', () => {
  network();
  const f = api.findings(ALL, DEFAULT_RULES).findings.filter((x) => x.rule === 'transfer');
  assert.deepEqual(f.map((x) => [x.id, x.facts.class, x.players.map((p) => p.name), x.measured.value, x.measured.unit, x.facts.item]).sort(), [
    [`transfer:${id(10)}`, 'created', ['Mikko_82'], 120_000n, 'money', null],
    [`transfer:${id(11)}`, 'parked', ['Brindle'], 90_000n, 'money', null],
    [`transfer:${id(8)}`, 'lost', ['AdmiralNoor'], 250_000n, 'money', null],
    [`transfer:${id(9)}`, 'twice', ['Ombrelune'], 70_000n, 'money', null],
    [`transfer:${id(17)}`, 'twice', ['AdmiralNoor'], 50_000n, 'items', ITEM.diamond], // the item that arrived too much, in its own unit
  ].sort());
  assert.ok(f.every((x) => x.level === 'high' && x.basis === 'proven' && x.servers[0] === 'mining-1'));
  assert.equal(f.find((x) => x.id === `transfer:${id(17)}`)!.facts.itemsOff, 2);
  assert.equal(f.find((x) => x.facts.class === 'twice')!.records.ledger.length, 2); // the records point at the master's rows
  // Flagged against not flagged: lost (8) and confirmed deposits with a row (1-3); twice (9) and the partly returned
  // converter commit (4); created (10) and the debited drop (6); parked (11) and the timeout the master did take (5).
  const flagged = new Set(f.map((x) => x.id));
  for (const ok of [...PLAIN, id(4), id(5), id(6), id(7)]) assert.ok(!flagged.has(`transfer:${ok}`), ok);
  // Nothing else on the network changes: only these four join the findings.
  open(fx.master);
  const before = api.findings(ALL, DEFAULT_RULES).findings.map((x) => x.id);
  network();
  assert.deepEqual(api.findings(ALL, DEFAULT_RULES).findings.map((x) => x.id).filter((x) => !before.includes(x)).sort(), [...flagged].sort());
  assert.equal(api.incidents(ALL, DEFAULT_RULES).incidents.length, 2); // none of them joins or makes an incident
});

test('scope: the time range keeps transfers that start in it, a server keeps its own and the master-only ones', () => {
  network();
  const ids = (scope: Scope) => api.transfers(scope).transfers.map((t) => t.id);
  assert.deepEqual(ids({ from: T0 + 100 * MIN, to: T0 + 116 * MIN, server: null }).sort(), [PLAIN[2]!, id(6), id(14)].sort());
  assert.deepEqual(ids({ ...ALL, server: 'nether-hub' }).sort(), [PLAIN[2]!, id(14)].sort());
  assert.equal(api.transfers({ ...ALL, server: 'nether-hub' }).counts.ok, 1);
});

// The cases the fixtures do not hold, straight through the classes' conditions.
test('classify: parking marks, known gaps and the drop cases', () => {
  const t = T0, copy = T0 + 60 * MIN;
  const step = (s: string, more: Partial<Pair['steps'][number]> = {}): Pair['steps'][number] =>
    ({ ts: t, step: s, direction: null, path: null, account: null, player: null, items: null, ledgerType: null, context: null, ...more });
  const req = (direction: string, path: string, raw: bigint, ledgerType: number | null = 1, context: string | null = 'terminal', item = 1) =>
    step('REQUESTED', { direction, path, items: new Map([[item, raw]]), ledgerType, context });
  const row = (kind: string, change: bigint, item = 1) => ({ id: 1, ts: t, account: 3, kind, item, amount: change < 0n ? -change : change, change });
  const of = (p: Partial<Pair>) => classify({ steps: [], rows: [], flags: [], gap: null, copy, money: new Set([1, NOTE]), ...p }).class;

  // A DROP the master parked (flag 6) or a user deletion's leg logged as lost: parked, unless the slave did deliver.
  const drop = (s: string, raw: bigint, item = 1) => step(s, { direction: 'FROM_MASTER', path: 'DROP', items: new Map([[item, raw]]) });
  assert.equal(of({ rows: [row('WITHDRAW', -500n)], flags: [{ id: 6, ts: t, account: 3 }] }), 'parked');
  assert.equal(of({ rows: [row('ACCOUNT_DELETE_LOSS', -500n)] }), 'parked');
  assert.equal(of({ steps: [drop('DELIVERED', 500n)], rows: [row('WITHDRAW', -500n)], flags: [{ id: 6, ts: t, account: 3 }] }), 'ok');
  // Debited, not delivered, not refunded, no flag: lost. Not delivered and not debited (a deletion leg the slave failed): ok.
  assert.equal(of({ steps: [drop('FAILED', 500n)], rows: [row('WITHDRAW', -500n)] }), 'lost');
  assert.equal(of({ steps: [drop('FAILED', 500n)] }), 'ok');
  // Delivered more than the account gave: twice.
  assert.equal(of({ steps: [drop('DELIVERED', 500n)], rows: [row('WITHDRAW', -500n), row('WITHDRAW_REFUND', 200n)] }), 'twice');
  // A withdrawal whose outcome stayed unknown is parked even when the master took nothing: the items may be in the terminal.
  assert.equal(of({ steps: [req('FROM_MASTER', 'ASYNC_BANK', 400n), step('TIMED_OUT')] }), 'parked');
  assert.equal(of({ steps: [req('FROM_MASTER', 'ASYNC_BANK', 400n), step('DELIVERED')], rows: [row('WITHDRAW', -400n)] }), 'ok');
  // Known gaps: the un-debited craft, and a refused deposit from outside the bank's blocks. In flight they are newer than the copy.
  assert.equal(of({ steps: [req('FROM_MASTER', 'ASYNC_BANK', 400n, 17)] }), 'known-gap');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n, 1, null)] }), 'known-gap');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n, 1, null)], copy: t + IN_FLIGHT - 1 }), 'after-snapshot');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n)] }), 'lost'); // the terminal gives refused items back (RETURNED): none here
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n), step('RETURNED')] }), 'ok');
  // Only on the master, every slave loaded: a credit came from nothing, a debit went nowhere. A data gap wins over both.
  assert.equal(of({ rows: [row('DEPOSIT', 400n)] }), 'created');
  assert.equal(of({ rows: [row('DOWNLOAD_WITHDRAW', -400n)] }), 'lost');
  assert.equal(of({ rows: [row('DEPOSIT', 400n)], gap: 'not loaded' }), 'data-gap');
  // Per item: banknotes and the money item are one; other items are each their own, so the same raw total is not enough.
  assert.equal(of({ steps: [drop('DELIVERED', 500n, NOTE)], rows: [row('WITHDRAW', -500n)] }), 'ok');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n, 1, 'terminal', 4), step('CONFIRMED')], rows: [row('DEPOSIT', 400n, 4)] }), 'ok');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n, 1, 'terminal', 4), step('CONFIRMED')], rows: [row('DEPOSIT', 400n, 2)] }), 'twice');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n, 1, 'terminal', 4), step('CONFIRMED')], rows: [row('DEPOSIT', 400n)] }), 'twice');
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n, 1, 'terminal', 4), step('CONFIRMED')], rows: [row('DEPOSIT', 300n, 4)] }), 'lost');
  // A row whose sign the save does not give counts the journal's way.
  assert.equal(of({ steps: [req('TO_MASTER', 'ASYNC_BANK', 400n), step('CONFIRMED')], rows: [{ ...row('UNKNOWN_LEGACY', 400n), change: null }] }), 'ok');
  // BS-267: notes the master did not hand out and could not book back. Lost with the bank's reason, journal or not; the
  // marker changes no balance, so it is not sent a second time.
  const refundLost = { ...row('REFUND_LOST', 0n), amount: 200n, note: 'banknotes not handed out, refund lost (refund deposit refused: FAILED): {money=2}' };
  const r = classify({ steps: [drop('DELIVERED', 300n)], rows: [row('WITHDRAW', -500n), refundLost], flags: [], gap: null, copy, money: new Set([1, NOTE]) });
  assert.deepEqual([r.class, r.items], ['lost', [{ item: null, sent: 500n, received: 300n }]]);
  assert.match(r.why, /could not be booked back \(refund deposit refused: FAILED\): the value is gone/);
  assert.equal(of({ rows: [row('WITHDRAW', -500n), refundLost], gap: 'not loaded' }), 'lost');

  // AT-47, a slave's withdrawal whose answer never came. The terminal (WITHDRAW, 2) leaves the items with the player; the
  // download block (16) does when the slave reported the park (flag 6 with the id), and took them back before.
  const out = (type: number, more: Partial<Pair> = {}) => classify({ steps: [req('FROM_MASTER', 'ASYNC_BANK', 400n, type, 'terminal', 4), { ...step('TIMED_OUT'), ts: t + 1 }],
    rows: [], flags: [], gap: null, copy, money: new Set([1, NOTE]), ...more });
  const reported = { id: 6, ts: t + 2, account: 3 };
  const unlock = (ts: number, amount = 400n) => ({ id: 9, ts, account: 3, kind: 'ADMIN_UNLOCK', item: 4, amount, change: 0n });
  // Paid, and the items stayed with the player: in order.
  assert.equal(out(2, { rows: [row('WITHDRAW', -400n, 4)] }).class, 'ok');
  assert.equal(out(16, { rows: [row('DOWNLOAD_WITHDRAW', -400n, 4)], flags: [reported] }).class, 'ok');
  // Paid, and the download block of an older save took the items back: paid and got nothing.
  const takenBack = out(16, { rows: [row('DOWNLOAD_WITHDRAW', -400n, 4)] });
  assert.deepEqual([takenBack.class, takenBack.items], ['parked', [{ item: 4, sent: 400n, received: 0n }]]);
  assert.match(takenBack.why, /likely paid and got nothing/);
  // Kept and not paid: the items count as handed out and the amount stays locked. Without the slave's report a lock freed
  // without a row is named as the limit. An unlock after the park, of at least the amount, makes it twice.
  const kept = out(2);
  assert.deepEqual([kept.class, kept.items, kept.locked], ['parked', [{ item: 4, sent: 0n, received: 400n }], [{ item: 4, amount: 400n }]]);
  assert.match(kept.why, /refused craft/);
  assert.doesNotMatch(out(2, { flags: [reported] }).why, /refused craft/);
  const twice = out(2, { unlocks: [unlock(t + 5)] });
  assert.deepEqual([twice.class, twice.unlock, twice.locked], ['twice', 9, []]);
  assert.equal(out(2, { unlocks: [unlock(t - 5)] }).class, 'parked');
  assert.equal(out(2, { unlocks: [unlock(t + 5, 100n)] }).class, 'parked');
  // Taken back and not paid: nothing moved, and what is at stake is the locked amount, never 0. Released by an unlock: ok.
  const old = out(16);
  assert.deepEqual([old.class, old.items, old.locked], ['parked', [], [{ item: 4, amount: 400n }]]);
  assert.equal(out(16, { unlocks: [unlock(t + 5)] }).class, 'ok');
});

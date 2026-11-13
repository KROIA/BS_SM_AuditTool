// The money flow (DESIGN_SPEC 6.6, 8.10) on the invented network with Tavrik's extra money (FLOW) and on the old 2.1.2
// save: the balance closes, each part is what the rows and orders say, proven and estimate, the player switch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { usualPrice } from '../../src/engine/query/markets.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type FlowPart, type MoneyFlow, type Scope } from '../../src/shared/api.ts';
import { buildFixtures, FLOW, ITEM, PLAYERS, T0, uuidText, WORLD, type Fixtures } from '../fixtures/build.ts';

const ALL: Scope = { from: null, to: null, server: null };
const tavrik = uuidText(PLAYERS.Tavrik.n), quenby = uuidText(PLAYERS.Quenby.n), ombrelune = uuidText(PLAYERS.Ombrelune.n);
const PUMP = `hour-profit:${tavrik}@${T0}`;
let fx: Fixtures;
let n = 0;
const open = (...saves: string[]) => {
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of saves) addSave(s);
};
const flow = (id = PUMP, player: string | null = null, scope = ALL) => api.moneyFlow(scope, id, player, DEFAULT_RULES);
const part = (f: MoneyFlow, kind: FlowPart['kind'], player = tavrik, more: Partial<FlowPart> = {}) => {
  const list = f.parts.filter((p) => p.kind === kind && p.player === player && Object.entries(more).every(([k, v]) => p[k as keyof FlowPart] === v));
  assert.equal(list.length, 1, `one ${kind} part of ${player} ${JSON.stringify(more)}`);
  return list[0]!;
};
/** Every player's parts in equal their parts out, and start and now are the accounts' balances. */
function closes(f: MoneyFlow) {
  for (const a of f.accounts) {
    const mine = f.parts.filter((p) => p.player === a.player);
    const sum = (side: 'in' | 'out') => mine.filter((p) => p.side === side).reduce((s, p) => s + p.amount, 0n);
    assert.equal(sum('in'), sum('out'), `${a.player} closes`);
    assert.equal(mine.find((p) => p.kind === 'start')!.amount, a.start);
    assert.equal(mine.find((p) => p.kind === 'now')!.amount, a.now);
    assert.ok(mine.every((p) => p.amount > 0n || p.kind === 'start' || p.kind === 'now'), 'no empty part');
  }
}
/** The orders of a player on a market, as money: + received, - paid. */
const cash = (player: string, item: number) => api.orders({ player, item }, ALL).reduce((s, o) => s - o.money, 0n);

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-flow-')), true)));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('current save: the pump incident closes per player, and each part is what its rows and orders say', () => {
  open(fx.master, ...fx.slaves);
  const f = flow();
  assert.equal(f.reason, null);
  assert.equal(f.legacy, false);
  assert.deepEqual(f.players.map((p) => p.uuid), [ombrelune, tavrik]); // the far-price finding at the top names both
  assert.deepEqual(f.accounts.map((a) => [a.account, a.from]), [[PLAYERS.Tavrik.account, T0 - 24 * 60 * 60_000], [PLAYERS.Ombrelune.account, T0 - 24 * 60 * 60_000]]);
  closes(f);

  assert.equal(part(f, 'start').amount, 50_000_000n);
  assert.equal(part(f, 'now').amount, fx.balances.master.get(`${PLAYERS.Tavrik.account}:${ITEM.money}`));
  const diamond = part(f, 'market', tavrik, { market: ITEM.diamond });
  assert.deepEqual([diamond.side, diamond.amount, diamond.incident, diamond.basis], ['in', cash(tavrik, ITEM.diamond), true, 'proven']);
  assert.equal(diamond.records.ledger.length, 60); // one trade row per order
  assert.ok(diamond.records.findings.includes(PUMP));
  // Coal: half kept at the buying price (items), the rest lost by selling it back for less.
  const [buy] = api.orders({ player: tavrik, item: ITEM.coal }, ALL).filter((o) => o.amount > 0n);
  const items = part(f, 'items', tavrik, { market: ITEM.coal }), lost = part(f, 'lost', tavrik, { market: ITEM.coal });
  assert.equal(items.amount, buy!.money / 2n);
  assert.equal(items.amount + lost.amount, -cash(tavrik, ITEM.coal));
  assert.deepEqual(items.items, { qty: FLOW.coalBought - FLOW.coalSold, worth: ((FLOW.coalBought - FLOW.coalSold) * usualPrice(ITEM.coal)!) / 100n });
  assert.deepEqual([items.side, items.incident, lost.side], ['out', false, 'out']);

  const notes = part(f, 'notes');
  assert.deepEqual([notes.side, notes.amount, notes.notes, notes.basis, notes.records.ledger.length], ['out', 400_000_000n, { out: 400_000_000n, back: 0n }, 'proven', 2]);
  assert.deepEqual([part(f, 'sent').other, part(f, 'sent').amount], [PLAYERS.Ombrelune.account, 100_000_000n]);
  assert.deepEqual([part(f, 'received').other, part(f, 'received').amount], [FLOW.from, FLOW.received]);
  assert.deepEqual([part(f, 'admin').side, part(f, 'admin').amount], ['in', FLOW.adminAdd]);
  assert.deepEqual([part(f, 'other').side, part(f, 'other').amount], ['in', FLOW.payout]);
  // The gain without a row is below the threshold: no finding, but it is not hidden.
  assert.deepEqual([part(f, 'unexplained').side, part(f, 'unexplained').amount, part(f, 'unexplained').basis], ['in', FLOW.unexplained, 'proven']);
  assert.ok(f.parts.every((p) => p.basis === 'proven'), 'everything on the current save is read from rows and orders');

  // Ombrelune: notes paid in (more than she took out), the transfer from Tavrik, her ride on the pump.
  assert.deepEqual([part(f, 'notes', ombrelune).side, part(f, 'notes', ombrelune).notes!.out], ['in', 0n]);
  assert.deepEqual([part(f, 'received', ombrelune).other, part(f, 'received', ombrelune).amount], [PLAYERS.Tavrik.account, 100_000_000n]);
  assert.equal(part(f, 'market', ombrelune, { market: ITEM.diamond }).amount, cash(ombrelune, ITEM.diamond));

  // Notes still outside, both players as one: what Ombrelune paid in is not outside any more. None in their files (Tavrik
  // has only a .dat_old), all found notes are elsewhere, the rest not found. Tavrik alone: his $4M.
  const out = 400_000_000n - part(f, 'notes', ombrelune).amount;
  assert.deepEqual(f.notes, { outside: out, inFiles: 0n, elsewhere: WORLD.found, notFound: out - WORLD.found });
  assert.deepEqual(flow(PUMP, tavrik).notes, { outside: 400_000_000n, inFiles: 0n, elsewhere: null, notFound: null });
  assert.deepEqual(f.missing, []);
});

test('the player switch: one player\'s parts and accounts only; the other incident; an unknown incident', () => {
  open(fx.master, ...fx.slaves);
  const all = flow(), one = flow(PUMP, ombrelune);
  assert.equal(one.player, ombrelune);
  assert.deepEqual(one.players, all.players); // the switch still lists everyone
  assert.deepEqual(one.accounts.map((a) => a.account), [PLAYERS.Ombrelune.account]);
  assert.deepEqual(one.parts, all.parts.filter((p) => p.player === ombrelune));
  closes(one);

  const q = flow(`order-rate:${quenby}@${T0 + 46 * 60_000}`);
  assert.deepEqual(q.parts.map((p) => [p.kind, p.side, p.amount]), [
    ['start', 'in', 10_000_000n], ['admin', 'out', 20_000_000n], ['market', 'in', cash(quenby, ITEM.emerald)], ['now', 'out', fx.balances.master.get(`${PLAYERS.Quenby.account}:${ITEM.money}`)],
  ]);
  assert.match(flow('no-such-incident').reason!, /not raised/);
});

test('the server filter takes trading elsewhere apart; the time range does not apply', () => {
  open(fx.master, ...fx.slaves);
  // Tavrik's orders were placed on the master: under mining-1 they are trading elsewhere, netted into one part.
  const f = flow(PUMP, tavrik, { from: T0 + 100 * 60_000, to: T0 + 101 * 60_000, server: 'mining-1' });
  closes(f);
  assert.equal(f.parts.filter((p) => p.kind === 'market' || p.kind === 'items' || p.kind === 'lost').length, 0);
  assert.deepEqual([part(f, 'other-server').side, part(f, 'other-server').amount], ['in', cash(tavrik, ITEM.diamond) + cash(tavrik, ITEM.coal)]);
  assert.equal(part(f, 'notes').amount, 400_000_000n); // bank rows belong to every server, and the range is ignored
  assert.match(f.missing.join(' '), /server filter applies to trading only/);
});

test('2.1.2: orders stand in for trades; notes, removals and money without a row are estimates', () => {
  open(fx.legacy);
  const f = flow();
  assert.equal(f.legacy, true);
  closes(f);
  assert.equal(part(f, 'market', tavrik, { market: ITEM.diamond }).records.orders.length, 60);
  assert.equal(part(f, 'market', tavrik, { market: ITEM.diamond }).basis, 'proven');
  // The $2M asked for at minute 51 is cut by the $500'000 put back without a row.
  assert.deepEqual([part(f, 'notes').amount, part(f, 'notes').basis], [350_000_000n, 'estimate']);
  // The converter (2.1.2 wrote no row) is at most the notes outside: probably notes paid in. The admin's $5M is more.
  assert.deepEqual([part(f, 'appeared').amount, part(f, 'appeared').basis], [FLOW.converter, 'estimate']);
  assert.deepEqual([part(f, 'added').amount, part(f, 'added').basis], [FLOW.adminAdd, 'estimate']);
  assert.equal(part(f, 'added').records.findings.length, 1);
  assert.equal(part(f, 'unexplained').amount, FLOW.unexplained);
  assert.equal(part(f, 'unexplained').basis, 'estimate'); // the rest after estimates is one too
  assert.equal(f.parts.filter((p) => ['admin', 'sent', 'received', 'other'].includes(p.kind)).length, 0); // 2.1.2 logged none
  const out = 350_000_000n - FLOW.converter - part(f, 'notes', ombrelune).amount;
  assert.deepEqual(f.notes, { outside: out, inFiles: out < WORLD.legacy ? out : WORLD.legacy, elsewhere: 0n, notFound: out < WORLD.legacy ? 0n : out - WORLD.legacy });
  // Tavrik alone: the notes in his own file, and no further split (the notes found elsewhere are one pool for everyone).
  const alone = flow(PUMP, tavrik).notes;
  assert.deepEqual(alone, { outside: 350_000_000n - FLOW.converter, inFiles: WORLD.legacy, elsewhere: null, notFound: null });
  assert.ok(f.to! > f.incident!.end, 'the copy was taken after the incident');
  assert.match(f.missing.join(' '), /2\.1\.2 logged no admin action/);

  // The admin's removal from Quenby: a negative gap, so "removed", an estimate, with its balance finding.
  const q = flow(`order-rate:${quenby}@${T0 + 46 * 60_000}`);
  closes(q);
  const removed = part(q, 'removed', quenby);
  assert.deepEqual([removed.side, removed.amount, removed.basis], ['out', 20_000_000n, 'estimate']);
  assert.deepEqual(removed.records.findings, [`balance:${PLAYERS.Quenby.account}:${ITEM.money}@${T0 + 61 * 60_000}`]); // the gap from her last snapshot before it
});

test('without a save or players, a sentence instead of a flow', () => {
  init(path.join(fx.root, `workspace-${++n}`));
  assert.match(flow().reason!, /No save/);
});

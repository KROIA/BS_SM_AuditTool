// Connected players (AT-41): a shared account and a transfer are proven, notes paid in at the exact amount
// another player withdrew are likely, overlapping sessions on one market are weak. Each kind with one near miss.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import type { PlayerLink, Scope } from '../../src/shared/api.ts';
import { addLinkCases, buildFixtures, ITEM, LINKS, PLAYERS, SHARED, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const id = (name: keyof typeof PLAYERS) => uuidText(PLAYERS[name].n);
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  addSave(save);
};
/** Note rows written into a copy of the master: [player, kind, raw amount, minute]. */
function withNotes(name: string, rows: [keyof typeof PLAYERS, 'WITHDRAW' | 'DEPOSIT', bigint, number][]) {
  const save = path.join(fx.root, name);
  fs.cpSync(fx.master, save, { recursive: true });
  const db = new DatabaseSync(path.join(save, 'data/BankSystem/Database/banksystem.db'));
  const row = db.prepare(`INSERT INTO TransactionLog (account_number, actor_uuid, actor_name, kind, type_code, item_id, amount, ts, source_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PLAYER')`);
  for (const [who, kind, amount, minute] of rows) row.run(PLAYERS[who].account, id(who), who, kind, kind === 'WITHDRAW' ? 2 : 1, ITEM.money, amount, T0 + minute * MIN);
  db.close();
  open(save);
}
const brief = (l: PlayerLink[]) => l.map((x) => [x.player.name, x.strength, x.ways.map((w) => w.kind)]);

before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-links-')));
  fs.cpSync(fx.master, path.join(fx.root, 'links'), { recursive: true });
  addLinkCases(path.join(fx.root, 'links'));
});
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('proven: the shared account and the transfer; a transfer outside the range is no link', () => {
  open(fx.master);
  const l = api.links(id('Tavrik'), ALL);
  // Ombrelune paid in 3M $ of notes, Tavrik withdrew 2M $ twice: the amount is off, so no note link.
  assert.deepEqual(brief(l), [['Ombrelune', 'proven', ['transfer']], ['Quenby', 'proven', ['account']]]);
  assert.deepEqual(l[0]!.ways[0], { kind: 'transfer', sent: 100_000_000n, received: 0n, transfers: 1 });
  assert.equal(l[0]!.records.ledger.length, 2, 'both sides of the transfer');
  assert.deepEqual(l[1]!.ways[0], { kind: 'account', account: SHARED.account, name: SHARED.name });
  // From Ombrelune's side the same transfer is received.
  assert.deepEqual(api.links(id('Ombrelune'), ALL)[0]!.ways[0], { kind: 'transfer', sent: 0n, received: 100_000_000n, transfers: 1 });
  // The transfer was at minute 55; the shared account is the state of the copy and stays.
  assert.deepEqual(brief(api.links(id('Tavrik'), { from: T0 + 56 * MIN, to: null, server: null })), [['Quenby', 'proven', ['account']]]);
});

test('likely: notes paid in at the exact amount another player withdrew shortly before', () => {
  open(path.join(fx.root, 'links'));
  const l = api.links(id('Tavrik'), ALL);
  const brindle = l.find((x) => x.player.name === 'Brindle')!;
  assert.equal(brindle.strength, 'likely');
  // Tavrik withdrew 2M $ at minute 50 and 51: the latest before the deposit is the one.
  assert.deepEqual(brindle.ways, [{ kind: 'notes', amount: LINKS.paidIn.amount, tookOut: true, withdrawn: [{ account: PLAYERS.Tavrik.account, ts: T0 + 51 * MIN + 500 }],
    paidIn: { account: PLAYERS.Brindle.account, from: LINKS.paidIn.ts, to: LINKS.paidIn.ts, logged: true } }]);
  assert.equal(brindle.records.ledger.length, 2);
  assert.ok(!l.find((x) => x.player.name === 'Ombrelune')!.ways.some((w) => w.kind === 'notes'), 'her 3M $ is off by 1M $');
  // Both sides must be in the range.
  assert.ok(!api.links(id('Tavrik'), { from: T0 + 52 * MIN, to: null, server: null }).some((x) => x.player.name === 'Brindle'));
});

test('likely on 2.1.2: money that appeared without a row counts as notes paid in', () => {
  open(fx.legacy);
  const brindle = api.links(id('Tavrik'), ALL).find((x) => x.player.name === 'Brindle')!;
  // The 2M $ asked for at minute 51 was cut to 1.5M $ by the put-back; the converter's 1.5M $ appeared on Brindle's account.
  assert.deepEqual([brindle.strength, brindle.ways], ['likely', [{ kind: 'notes', amount: 150_000_000n, tookOut: true, withdrawn: [{ account: PLAYERS.Tavrik.account, ts: T0 + 51 * MIN + 500 }],
    paidIn: { account: PLAYERS.Brindle.account, from: T0 + 63 * MIN, to: T0 + 81 * MIN, logged: false } }]]);
  assert.deepEqual(api.links(id('Brindle'), ALL).find((x) => x.player.name === 'Tavrik')!.ways[0], { ...brindle.ways[0]!, tookOut: false });
});

test('weak: the same market in sessions that overlap, with the minutes; sessions apart are no link', () => {
  open(path.join(fx.root, 'links'));
  const l = api.links(id('Brindle'), ALL);
  assert.deepEqual(brief(l), [['Tavrik', 'likely', ['notes']], ['Mikko_82', 'weak', ['market']]]);
  // Brindle's coal 60 to 66, Mikko_82's 61 to 64. The wheat orders 6 minutes apart are not in it.
  assert.deepEqual(l[1]!.ways, [{ kind: 'market', item: ITEM.coal, overlapMs: 3 * MIN, sessions: 1 }]);
  const orders = api.orders({ ids: l[1]!.records.orders }, ALL);
  assert.equal(orders.length, 6, 'four coal orders of Brindle and two of Mikko_82');
  assert.ok(orders.every((o) => o.item === ITEM.coal));
  assert.deepEqual(brief(api.links(id('Mikko_82'), ALL)), [['Brindle', 'weak', ['market']]]);
  assert.deepEqual(api.links(id('Mikko_82'), { from: T0 + 67 * MIN, to: null, server: null }), [], 'the sessions are before the range');
});

test('likely: a run of withdrawals that adds up to the deposit; a withdrawal goes to one deposit only', () => {
  withNotes('runs', [
    // Quenby takes out 1M $ and 500'000 $; Mikko_82 pays in 1.5M $: a run of two.
    ['Quenby', 'WITHDRAW', 100_000_000n, 100], ['Quenby', 'WITHDRAW', 50_000_000n, 101], ['Mikko_82', 'DEPOSIT', 150_000_000n, 105],
    // Ombrelune takes out 700'000 $ once; Mikko_82 and then AdmiralNoor pay in 700'000 $: the older deposit gets it.
    ['Ombrelune', 'WITHDRAW', 70_000_000n, 110], ['Mikko_82', 'DEPOSIT', 70_000_000n, 111], ['AdmiralNoor', 'DEPOSIT', 70_000_000n, 112],
  ]);
  const mikko = api.links(id('Mikko_82'), ALL);
  assert.deepEqual(brief(mikko), [['Ombrelune', 'likely', ['notes']], ['Quenby', 'likely', ['notes']]]);
  const run = mikko[1]!.ways[0]!;
  assert.ok(run.kind === 'notes');
  assert.deepEqual([run.amount, run.withdrawn], [150_000_000n, [{ account: PLAYERS.Quenby.account, ts: T0 + 100 * MIN }, { account: PLAYERS.Quenby.account, ts: T0 + 101 * MIN }]]);
  assert.equal(mikko[1]!.records.ledger.length, 3, 'both withdrawals and the deposit');
  assert.deepEqual(api.links(id('AdmiralNoor'), ALL).filter((l) => l.strength === 'likely'), [], 'the withdrawal is claimed already');
});

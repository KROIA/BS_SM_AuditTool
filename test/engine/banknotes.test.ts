// The banknote count on the invented network and on the old 2.1.2 save: which log rows count, NoteFlow
// valued by denomination, the totals per account and player, the range and server filter, and what a save cannot show.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { noteChange } from '../../src/engine/query/banknotes.ts';
import { noteWorth } from '../../src/engine/query/check.ts';
import { addSave, init, mainData } from '../../src/engine/workspace.ts';
import type { BanknoteGap, Scope } from '../../src/shared/api.ts';
import { buildFixtures, ITEM, NOTE, PLAYERS, STRAY, T0, VOUCHER, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
let fx: Fixtures;
let n = 0;
const open = (...saves: string[]) => {
  init(path.join(fx.root, `workspace-${++n}`));
  for (const s of saves) addSave(s);
};

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-notes-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('which money rows of the log hand notes out (+), take them in (-), or neither (0); unknown direction is null', () => {
  for (const k of ['WITHDRAW', 'DOWNLOAD_WITHDRAW', 'CRAFT_CONSUME', 'ACCOUNT_DELETE_PAYOUT']) assert.equal(noteChange(k, 500n, null, null), 500n, k);
  for (const k of ['DEPOSIT', 'UPLOAD_DEPOSIT', 'CRAFT_OUTPUT', 'WITHDRAW_REFUND']) assert.equal(noteChange(k, 500n, null, null), -500n, k);
  // SHARE_TRADE is signed: negative when it withdrew.
  assert.equal(noteChange('SHARE_TRADE', -500n, null, null), 500n);
  assert.equal(noteChange('SHARE_TRADE', 500n, null, null), -500n);
  // Code 13 is neither: NoteFlow's converter_in counted those notes already (interfaces draft, bug note under B4).
  for (const k of ['CONVERTER_DEPOSIT', 'CONVERTER_WITHDRAW', 'TRANSFER', 'ADMIN_ADD', 'ADMIN_REMOVE', 'STARTING_BALANCE', 'ACCOUNT_DELETE_LOSS', 'TRADE_SELL', 'RAW_CHANGE']) {
    assert.equal(noteChange(k, 500n, null, null), 0n, k);
  }
  assert.equal(noteChange('DEPOSIT', 500n, 'banknote banksystem:money100 x5', null), -500n);
  assert.equal(noteChange('DEPOSIT', 500n, 'coin lightmanscurrency:coin_gold x5', null), 0n); // another mod's coins into a bound slot
  assert.equal(noteChange('UNKNOWN_LEGACY', 500n, 'rejected code 25 from slave mining-1', null), null);
});

test('what one note is worth: the base item $1, banksystem:money100 $100; a money item with components is no note', () => {
  open(fx.master);
  const worth = noteWorth(mainData()!);
  assert.equal(worth.get(ITEM.money), 100n);
  assert.equal(worth.get(NOTE), 10_000n);
  assert.equal(worth.has(VOUCHER), false);
  assert.equal(worth.has(ITEM.diamond), false);
});

test('the network: log rows plus NoteFlow of every server, per account (proven) and per player (estimate)', () => {
  open(fx.master, ...fx.slaves);
  const r = api.banknotes(ALL);
  assert.equal(r.reason, null);
  // Out: Tavrik's two withdrawals ($2M each), Mikko_82's drop of $5'000 less its $2'000 refund, Quenby's $50 delete payout.
  // Back: every money deposit.
  assert.deepEqual(r.ledger, { out: 400_305_000n, back: 302_300_000n });
  assert.deepEqual([r.putBack, r.appeared, r.tooLarge], [0n, [], []]); // the cut to the balance drop is for 2.1.2 only
  assert.deepEqual(r.flow, [
    { source: 'banksystem:converter_in', created: 0n, destroyed: 2_400n }, // 12 x $1 on each slave
    { source: 'banksystem:converter_out', created: 34_000n, destroyed: 0n }, // 40 x $1, and 3 x $100 on mining-1
    { source: 'banksystem:creative_create', created: 50_000n, destroyed: 0n },
    { source: 'banksystem:creative_destroy', created: 0n, destroyed: 10_000n },
    { source: 'banksystem:give', created: 20_000n, destroyed: 0n }, // the diamonds given on mining-1 are no money: skipped
    { source: 'other', created: 100n, destroyed: 0n },
    { source: 'stockmarket:villager_change', created: 200n, destroyed: 0n },
    { source: 'stockmarket:villager_consume', created: 0n, destroyed: 1_000n },
    { source: 'stockmarket:villager_pay', created: 300n, destroyed: 0n },
  ]);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.unclear, { rows: 1, amount: 30_000n });
  assert.equal(r.outstanding, 98_000_000n + 96_200n);
  assert.equal(r.series.at(-1)![1], r.outstanding);
  assert.deepEqual(r.missing, []);

  assert.deepEqual(r.accounts.map((a) => [a.account, a.owner?.name, a.out, a.back, a.net, a.basis]), [
    [PLAYERS.Tavrik.account, 'Tavrik', 400_000_000n, 0n, 400_000_000n, 'proven'],
    [STRAY.account, undefined, 5_000n, 0n, 5_000n, 'proven'], // deleted: no owner in the bank files
    [PLAYERS.Mikko_82.account, 'Mikko_82', 300_000n, 730_000n, -430_000n, 'proven'],
    [PLAYERS.Brindle.account, 'Brindle', 0n, 1_430_000n, -1_430_000n, 'proven'],
    [PLAYERS.Ombrelune.account, 'Ombrelune', 0n, 300_140_000n, -300_140_000n, 'proven'],
  ]);
  assert.deepEqual(r.players.map((p) => [p.player.name, p.out, p.back, p.created, p.destroyed, p.net, p.basis]), [
    ['Tavrik', 400_000_000n, 0n, 4_000n, 0n, 400_004_000n, 'estimate'],
    ['AdmiralNoor', 0n, 0n, 70_000n, 10_000n, 60_000n, 'estimate'],
    ['Quenby', 5_000n, 0n, 0n, 0n, 5_000n, 'estimate'], // the deleted user named in the payout's note, not the admin who deleted them
    ['Mikko_82', 300_000n, 730_000n, 0n, 0n, -430_000n, 'estimate'],
    ['Brindle', 0n, 1_430_000n, 30_100n, 2_400n, -1_402_300n, 'estimate'],
    ['Ombrelune', 0n, 300_140_000n, 500n, 1_000n, -300_140_500n, 'estimate'],
  ]);
});

test('the time range limits the movements; outstanding and the series count everything up to its end', () => {
  open(fx.master, ...fx.slaves);
  const r = api.banknotes({ from: T0 + 40 * MIN, to: T0 + 50 * MIN + 600, server: null });
  assert.deepEqual(r.ledger, { out: 200_000_000n, back: 150_000n }); // Tavrik's first withdrawal, Brindle's deposit at minute 45
  assert.deepEqual(r.flow, []);
  // Before minute 40: Ombrelune's two deposits, Brindle's $12'000 and the slaves' NoteFlow of minutes 20 to 23.
  assert.deepEqual(r.series, [[T0 + 40 * MIN, -1_312_300n], [T0 + 45 * MIN + 1000, -1_462_300n], [T0 + 50 * MIN + 500, 198_537_700n]]);
  assert.equal(r.outstanding, 198_537_700n);
});

test('a server filter keeps the log rows made there and that server\'s NoteFlow', () => {
  open(fx.master, ...fx.slaves);
  const mining = api.banknotes({ ...ALL, server: 'mining-1' });
  assert.deepEqual(mining.ledger, { out: 200_300_000n, back: 2_130_000n });
  assert.equal(mining.outstanding, 198_170_000n + 28_900n);
  assert.deepEqual(mining.unclear, { rows: 1, amount: 30_000n });
  const nether = api.banknotes({ ...ALL, server: 'nether-hub' });
  assert.deepEqual([nether.ledger, nether.outstanding], [{ out: 0n, back: 170_000n }, -171_200n]);
});

test('a slave the master knows but that is not loaded is named', () => {
  open(fx.master, fx.slaves[0]!);
  assert.deepEqual(api.banknotes(ALL).missing, ['The slave "nether-hub" is not loaded, so notes made or destroyed there outside the bank are not counted.']);
});

test('2.1.2: the log alone, withdrawals cut to the balance drop, money that appeared without a row listed apart', () => {
  open(fx.legacy);
  const r = api.banknotes(ALL);
  assert.equal(r.reason, null);
  // Tavrik's second withdrawal asked for $2M; $500'000 of it went back without a row, so the balance fell $1.5M.
  // Back: Ombrelune's $3M. 2.1.2 created accounts with their starting balance and no row.
  assert.deepEqual([r.ledger, r.putBack], [{ out: 350_000_000n, back: 300_000_000n }, 50_000_000n]);
  assert.deepEqual([r.flow, r.skipped], [[], 0]);
  assert.equal(r.outstanding, 50_000_000n);
  assert.deepEqual(r.accounts.filter((a) => a.out > 0n).map((a) => [a.account, a.out, a.basis]), [[PLAYERS.Tavrik.account, 350_000_000n, 'estimate']]);
  assert.ok(r.accounts.filter((a) => a.out === 0n).every((a) => a.basis === 'proven'));
  // Brindle's $1.5M paid in through the ATM converter: no row, and at most the $3.5M of notes outside the bank at the
  // gap's start, so it could be notes coming back. Listed, not taken off the count.
  const gap = (a: BanknoteGap) => [a.account, a.owner?.name, a.from, a.to, a.amount];
  assert.deepEqual(r.appeared.map(gap), [[PLAYERS.Brindle.account, 'Brindle', T0 + 63 * MIN, T0 + 81 * MIN, 150_000_000n]]);
  // An admin raised Mikko_82's balance by $10M, unlogged: no note was outside the bank when that gap began (minute 13).
  assert.deepEqual(r.tooLarge.map(gap), [[PLAYERS.Mikko_82.account, 'Mikko_82', T0 + 13 * MIN, T0 + 91 * MIN, 1_000_000_000n]]);
  assert.deepEqual(r.missing, [
    '"old-world" has no banknote log (BankSystem 2.1.2 and older kept none), so notes made or destroyed there outside the bank (converter, villagers, creative mode, /give) are not counted.',
    'BankSystem 2.1.2 logged the amount a player asked to withdraw, also when notes that did not fit went back into the account, so the tool takes how far the balance actually fell (an estimate from the balance history).',
    'Money also appeared on accounts without a log row, each time at most the notes then outside the bank, so it could be notes paid back in through the ATM converter, which 2.1.2 did not log. It is not taken off the count.',
    'Other money that appeared without a log row is more than all notes outside the bank at that time: an admin action or another cause.',
  ]);
  // With a server chosen, the filter's limit is said once, after both.
  const filtered = api.banknotes({ ...ALL, server: 'old-world' }).missing;
  assert.equal(filtered.filter((m) => m.includes('server filter')).length, 1);
  assert.equal(filtered.at(-1), 'The server filter does not apply to money that appeared without a log row: a gap between two snapshots belongs to no server.');
  // A range after the withdrawal and before the converter deposit: the cut stays in what is outstanding (everything up
  // to minute 60, so without Ombrelune's $3M at minute 70), and neither the put-back nor the list is in the range.
  const later = api.banknotes({ from: T0 + 55 * MIN, to: T0 + 60 * MIN, server: null });
  assert.deepEqual([later.putBack, later.appeared, later.outstanding], [0n, [], r.outstanding + 300_000_000n]);
});

test('nothing loaded: a reason, never an error', () => {
  init(path.join(fx.root, `workspace-${++n}`));
  const r = api.banknotes(ALL);
  assert.ok(r.reason && r.reason.length > 10);
  assert.equal(r.outstanding, 0n);
});

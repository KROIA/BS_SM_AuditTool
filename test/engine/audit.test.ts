import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { parseEntry, placeInTime, readAuditLog } from '../../src/engine/save/audit.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type Scope } from '../../src/shared/api.ts';
import { AUDIT_OFFSET, buildFixtures, CHECK, COMPANY, ITEM, LOST_FLAG, PLAYERS, T0, uuidText, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
const ALL: Scope = { from: null, to: null, server: null };
const NOOR = uuidText(PLAYERS.AdmiralNoor.n);
let fx: Fixtures;
let n = 0;
const open = (save: string) => {
  init(path.join(fx.root, `workspace-${++n}`));
  return addSave(save).saves[0]!;
};
const local = (ms: number) => Math.floor((ms + AUDIT_OFFSET) / 1000) * 1000;

before(() => (fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-audit-')))));
after(() => {
  init(fx.root);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('entries: FLAG with details over several lines, ADMIN with a ledger row, the BS-257 changes, raw text', () => {
  const at = Date.UTC(2026, 10, 4, 11, 0, 5);
  assert.deepEqual(parseEntry('2026-11-04 11:00:05 FLAG 8 account 41 severity 3 amount 500 ref c:1 "more shares\nheld: 1005"'), {
    local: at, kind: 'FLAG', type: '8', account: 41, item: null, amount: 500n, severity: 3, ref: 'c:1', actor: null, actorUuid: null, player: null, subject: null, state: null, text: 'more shares\nheld: 1005',
  });
  const flag = parseEntry('2026-11-04 11:00:05 FLAG 5 account 0 severity 1');
  assert.deepEqual([flag.kind, flag.amount, flag.text], ['FLAG', 0n, null]); // a zero amount and no details are left out of the line
  const admin = parseEntry(`2026-11-04 11:00:05 ADMIN ADMIN_REMOVE account 7 item 1 amount 20000000 by AdmiralNoor (${NOOR.toUpperCase()}) note "said "sorry"\nlater"`);
  assert.deepEqual([admin.kind, admin.type, admin.account, admin.item, admin.amount, admin.actor, admin.actorUuid, admin.text],
    ['ADMIN', 'ADMIN_REMOVE', 7, 1, 20_000_000n, 'AdmiralNoor', NOOR, 'said "sorry"\nlater']);
  const freeze = parseEntry('2026-11-04 11:00:05 ADMIN ACCOUNT_FREEZE account 3 by ADMIN');
  assert.deepEqual([freeze.kind, freeze.item, freeze.amount, freeze.actor, freeze.text], ['ADMIN', null, 0n, 'ADMIN', null]);

  const change = (line: string) => {
    const e = parseEntry('2026-11-04 11:00:05 ' + line);
    return [e.kind, e.type, e.state, e.actor, e.actorUuid, e.player, e.account, e.item];
  };
  assert.deepEqual(change(`ADMIN RIGHTS_OP player ${NOOR} "Noor" state admin by CONSOLE`), ['CHANGE', 'RIGHTS_OP', 'admin', 'CONSOLE', null, NOOR, null, null]);
  assert.deepEqual(change('ADMIN SLAVE_UNTRUST slave "a state b" state untrusted by Brindle'), ['CHANGE', 'SLAVE_UNTRUST', 'untrusted', 'Brindle', null, null, null, null]);
  assert.deepEqual(change('ADMIN ITEM_DISALLOW item 13 "oldmod:ruby" state disallowed by CONSOLE'), ['CHANGE', 'ITEM_DISALLOW', 'disallowed', 'CONSOLE', null, null, null, 13]);
  assert.deepEqual(change(`ADMIN FLAG_ACK company 1 "Rail" account 41 flag SHARE_EXCESS excess 500 state acknowledged by AdmiralNoor (${NOOR})`),
    ['CHANGE', 'FLAG_ACK', 'acknowledged', 'AdmiralNoor', NOOR, null, 41, null]);

  for (const line of ['not a log line', '2026-02-30 11:00:05 FLAG 1 account 1 severity 1', '2026-11-04 11:00:05 FLAG 1 account 1 severity 1 amount 99999999999999999999',
    '2026-11-04 11:00:05 FLAG 1 account 1 severity 1 "details without their closing quote', '2026-11-04 11:00:05 SOMETHING else']) {
    assert.equal(parseEntry(line).kind, 'RAW', line);
    assert.equal(parseEntry(line).text, line);
  }
});

test('the fixture log: dated files only, CRLF, a line the bank did not write kept as text', () => {
  const log = readAuditLog(path.join(fx.master, 'data'))!;
  assert.equal(log.bounded, false);
  assert.deepEqual(log.entries.map((e) => e.kind), ['RAW', 'ADMIN', 'FLAG', 'FLAG', 'CHANGE', 'FLAG', 'FLAG', 'ADMIN', 'ADMIN', 'CHANGE', 'CHANGE']);
  assert.equal(log.entries[0]!.text, 'server restarted, audit file rotated by hand');
  assert.deepEqual([log.entries[3]!.type, log.entries[3]!.text], ['8', 'more shares than issued\nissued: 1000 shares\nheld: 1005 shares']);
  assert.equal(readAuditLog(path.join(fx.legacy, 'data')), null);
});

test('size bounds: the total stops the reading, an over-long entry is kept cut as raw text', () => {
  const data = path.join(fx.master, 'data');
  const short = readAuditLog(data, { total: 300, entry: 64 * 1024 })!;
  assert.equal(short.bounded, true);
  assert.equal(short.bytes, 300);
  assert.ok(short.entries.length > 1 && short.entries.length < 6);
  const cut = readAuditLog(data, { total: 1 << 20, entry: 100 })!;
  const long = cut.entries.filter((e) => e.kind === 'RAW' && e.local === null && e.text!.length === 100);
  assert.ok(long.length >= 3); // the BS-257 lines and the multi-line flag are longer than 100 characters
  assert.equal(cut.entries.length, 11);
});

test('time zone: one file whose matches agree, and none in this computer\'s zone', () => {
  const at = Date.UTC(2026, 10, 4, 11, 0, 5);
  const rows = [{ id: 1, ts: at - 3_600_000 - 400, key: 'a' }, { id: 2, ts: at - 3_600_000 + 9_000, key: 'b' }];
  const found = placeInTime([{ local: at, key: 'a', file: 0 }, { local: at + 9_000, key: 'b', file: 0 }, { local: at, key: null, file: 0 }, { local: null, key: 'a', file: 0 }], rows, 1);
  assert.deepEqual([found.zones, found.matches], [[{ offset: 3_600_000, how: 'matched' }], 2]);
  assert.deepEqual(found.placed, [{ ts: at - 3_600_000, approximate: false, row: 1 }, { ts: at + 9_000 - 3_600_000, approximate: false, row: 2 },
    { ts: at - 3_600_000, approximate: false, row: null }, { ts: null, approximate: false, row: null }]);

  const none = placeInTime([{ local: at, key: 'a', file: 0 }], [{ id: 1, ts: at - 3_600_000 - 400_000, key: 'a' }], 1);
  assert.deepEqual([none.zones, none.matches, none.placed[0]], [[{ offset: null, how: 'approximate' }], 0, { ts: new Date(2026, 10, 4, 11, 0, 5).getTime(), approximate: true, row: null }]);
});

test('time zone per file: a clock change between files, neighbours for files without matches, a change inside a day', () => {
  const H = 3_600_000, day = (d: number) => Date.UTC(2026, 9, d, 12, 0, 0); // local noon in October
  // Files: 0 summer time (+2), 1 no matches, 2 winter time (+1), 3 no matches, 4 both offsets on one day.
  const entries = [
    { local: day(24), key: 'a', file: 0 }, { local: day(25), key: null, file: 1 }, { local: day(26), key: 'b', file: 2 },
    { local: day(27), key: null, file: 3 }, { local: day(28), key: 'c', file: 4 }, { local: day(28) + H, key: 'd', file: 4 },
  ];
  const rows = [{ id: 1, ts: day(24) - 2 * H, key: 'a' }, { id: 2, ts: day(26) - H, key: 'b' }, { id: 3, ts: day(28) - 2 * H, key: 'c' }, { id: 4, ts: day(28) + H - H, key: 'd' }];
  const r = placeInTime(entries, rows, 5);
  assert.deepEqual(r.zones, [
    { offset: 2 * H, how: 'matched' },
    { offset: 2 * H, how: 'approximate' }, // between +2 and +1: the earlier one, approximate
    { offset: H, how: 'matched' },
    { offset: H, how: 'neighbour' }, // the nearest earlier file with matches
    { offset: 2 * H, how: 'approximate' }, // its own matches disagree: the first offset seen, approximate
  ]);
  assert.deepEqual(r.placed.map((p) => [p.ts, p.approximate, p.row]), [
    [day(24) - 2 * H, false, 1], [day(25) - 2 * H, true, null], [day(26) - H, false, 2], [day(27) - H, false, null], [day(28) - 2 * H, true, 3], [day(28) + H - 2 * H, true, 4],
  ]);
  // A file before the first one with matches takes the next one's offset.
  const first = placeInTime([{ local: day(23), key: null, file: 0 }, { local: day(24), key: 'a', file: 1 }], rows, 2);
  assert.deepEqual(first.zones[0], { offset: 2 * H, how: 'neighbour' });
});

test('import: the offset found from the flags and admin rows, shown with the source', () => {
  const save = open(fx.master);
  const audit = save.sources.find((s) => s.id === 'audit')!;
  assert.deepEqual([audit.status, audit.tables[0]!.rows, audit.note], ['read', 11, 'server time UTC+01:00, from 6 entries matched to the database, 1 entry not readable (kept as text)']);
  assert.deepEqual(save.warnings, []);
});

test('a flag only the audit log has becomes a finding of its own; logged flags with a row stay one finding', () => {
  open(fx.master);
  const flags = api.findings(ALL, DEFAULT_RULES).findings.filter((f) => f.rule === 'bank-flag');
  assert.equal(flags.length, 4);
  const lost = flags.filter((f) => f.facts.origin === 'audit log');
  assert.deepEqual(lost.map((f) => [f.start, f.accounts, f.level, f.measured.value, f.facts.flagType, f.facts.ref, f.facts.details, f.facts.approximateTime, f.records.flags, f.acknowledged]),
    [[LOST_FLAG.ts, [LOST_FLAG.account], 'critical', LOST_FLAG.amount, LOST_FLAG.type, 'note:lost', 'large banknote withdrawal', false, [], null]]);
});

test('admin events: both shapes in time order, with the ledger row where there is one', () => {
  open(fx.master);
  const events = api.adminEvents(ALL);
  assert.deepEqual(events.map((e) => [e.time, e.type, e.account, e.item, e.amount, e.actor, e.actorUuid, e.player, e.state, e.ledgerId !== null, e.approximate]), [
    [T0 + 30 * MIN, 'ADMIN_SET', CHECK.set, ITEM.money, 1_000_000n, 'ADMIN', null, null, null, true, false],
    [T0 + 65 * MIN, 'FLAG_ACK', COMPANY.account, null, null, 'AdmiralNoor', NOOR, null, 'acknowledged', false, false],
    [T0 + 120 * MIN, 'ADMIN_REMOVE', PLAYERS.Quenby.account, ITEM.money, 20_000_000n, 'AdmiralNoor', NOOR, null, null, true, false],
    [T0 + 125 * MIN, 'ADMIN_SET', PLAYERS.AdmiralNoor.account, ITEM.money, 2_500_000n, 'AdmiralNoor', NOOR, null, null, true, false],
    [T0 + 128 * MIN, 'RIGHTS_OP', null, null, null, 'AdmiralNoor', NOOR, uuidText(PLAYERS.Brindle.n), 'admin', false, false],
    [T0 + 129 * MIN, 'SLAVE_TRUST', null, null, null, 'CONSOLE', null, null, 'trusted', false, false],
  ]);
  assert.deepEqual([events[0]!.note, events[1]!.note, events[5]!.subject], ['balance corrected', null, 'slave "mining-1"']);
  const ledger = api.ledger({ accounts: [CHECK.set] }, ALL);
  assert.ok(ledger.some((r) => r.id === events[0]!.ledgerId));
  assert.deepEqual(api.adminEvents({ from: T0 + 100 * MIN, to: T0 + 126 * MIN, server: null }).map((e) => e.type), ['ADMIN_REMOVE', 'ADMIN_SET']);
  open(fx.legacy);
  assert.deepEqual(api.adminEvents(ALL), []);
});

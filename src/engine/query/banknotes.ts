// The banknote count (DESIGN_SPEC 8.7): how much money in notes should exist outside the bank. Notes the master's log
// handed out minus those paid back in (print and redeem classification of the interfaces draft, B4), plus and minus what
// NoteFlow recorded on each loaded server. The notes found in the world are the other side; the rule compares them (AT-35).
import type { SQLInputValue } from 'node:sqlite';
import { DEFAULT_RULES, type BanknoteAccount, type BanknoteGap, type BanknotePlayer, type BanknotesResult, type SaveSummary, type Scope } from '../../shared/api.ts';
import { loadedSaves, mainData, mainSave, saveData } from '../workspace.ts';
import { allGaps, moneyItems, noteWorth } from './check.ts';
import { all, big, names, num, series, text } from './db.ts';
import { change, onServer } from './players.ts';
import { isSlaveOf } from './transfers.ts';

/**
 * Money rows of these kinds move notes across the bank's counter (draft B4): WITHDRAW, DOWNLOAD_WITHDRAW, CRAFT_CONSUME,
 * ACCOUNT_DELETE_PAYOUT and SHARE_TRADE's withdraw side hand them out; DEPOSIT, UPLOAD_DEPOSIT, CRAFT_OUTPUT and
 * SHARE_TRADE's deposit side take them in; WITHDRAW_REFUND undoes a hand-out. CONVERTER_DEPOSIT is neither: NoteFlow's
 * converter_in already counted those notes when they went into the converter.
 */
const NOTE_KINDS = ['WITHDRAW', 'DOWNLOAD_WITHDRAW', 'CRAFT_CONSUME', 'ACCOUNT_DELETE_PAYOUT', 'SHARE_TRADE', 'DEPOSIT', 'UPLOAD_DEPOSIT', 'CRAFT_OUTPUT', 'WITHDRAW_REFUND'];
const KINDS = new Set(NOTE_KINDS);
/** The sources the mods write (DATA_SOURCES, NoteFlow); anything else is summed as "other". */
const SOURCES = new Set(['banksystem:converter_in', 'banksystem:converter_out', 'banksystem:creative_create', 'banksystem:creative_destroy', 'banksystem:give',
  'stockmarket:villager_pay', 'stockmarket:villager_change', 'stockmarket:villager_consume']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A delete payout's note names the deleted user (ServerBankManager.logDeletePayout): the notes are theirs, not the admin's. */
const DELETED = /^user deleted: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/**
 * What one money row of the log did to the notes outside the bank: + handed out, - paid in, 0 neither. null when the save
 * does not say which way it went (UNKNOWN_LEGACY, which a rejected slave code is stored as, unsigned).
 * A terminal deposit of another mod's coins into a bound slot ("coin <item> x<n>", BankTerminalBlockEntity.java:1100-1103) is no note.
 */
export function noteChange(kind: string, amount: bigint, note: string | null, balanceAfter: bigint | null): bigint | null {
  if (kind === 'UNKNOWN_LEGACY') return null;
  if (!KINDS.has(kind) || (kind === 'DEPOSIT' && note?.startsWith('coin '))) return 0n;
  return -change(kind, amount, note, balanceAfter)!; // every kind above has a known sign
}

const hasFlow = (s: SaveSummary) => s.sources.find((x) => x.id === 'bankDiag')?.tables.some((t) => t.name === 'NoteFlow') ?? false;
const list = (words: string[]) => {
  const q = words.map((w) => `"${w}"`);
  return q.length < 2 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
};

/** One movement of notes, oldest first. account null: a NoteFlow row. */
interface Move { ts: number; delta: bigint; account: number | null; player: string | null; refund: boolean; withdraw: boolean; source: string | null }

const empty = (reason: string): BanknotesResult =>
  ({ reason, outstanding: 0n, ledger: { out: 0n, back: 0n }, putBack: 0n, appeared: [], tooLarge: [], flow: [], accounts: [], players: [], series: [], unclear: { rows: 0, amount: 0n }, skipped: 0, missing: [] });

export function banknotes(scope: Scope): BanknotesResult {
  const db = mainData(), main = mainSave();
  if (!db || !main) return empty('No save with bank data is loaded, so no note can be counted.');
  const money = moneyItems(db), worth = noteWorth(db);
  if (!money.size) return empty('The save does not say which item is money (ItemIDs.nbt), so no note can be counted.');
  const inRange = (ts: number) => scope.from === null || ts >= scope.from;
  const params: Record<string, SQLInputValue> = { money: JSON.stringify([...money]) };
  if (scope.to !== null) params.to = scope.to;
  const until = scope.to !== null ? 'AND ts <= :to' : '';

  const nameOf = names(db);
  const owner = new Map(all(db, 'SELECT number, owner FROM account WHERE owner IS NOT NULL').map((r) => [num(r.number)!, String(r.owner)]));
  const person = (uuid: string | undefined) => (uuid ? { uuid, name: nameOf(uuid) } : null);
  const moves: Move[] = [];
  const unclear = { rows: 0, amount: 0n };
  for (const r of all(db, `SELECT ts, account, actor, kind, amount, note, balance_after FROM ledger WHERE item IN (SELECT value FROM json_each(:money))
      AND kind IN (${[...NOTE_KINDS, 'UNKNOWN_LEGACY'].map((k) => `'${k}'`).join(', ')}) ${until} ${onServer(scope, params)} ORDER BY ts, id`, params)) {
    const ts = num(r.ts)!, amount = big(r.amount)!, kind = String(r.kind);
    const delta = noteChange(kind, amount, text(r.note), big(r.balance_after));
    if (delta === null) {
      if (inRange(ts)) { unclear.rows++; unclear.amount += amount < 0n ? -amount : amount; }
    } else if (delta !== 0n) {
      const account = num(r.account)!, actor = text(r.actor);
      const player = kind === 'ACCOUNT_DELETE_PAYOUT' ? DELETED.exec(text(r.note) ?? '')?.[1] ?? owner.get(account) ?? null : actor && UUID.test(actor) ? actor : null;
      moves.push({ ts, delta, account, player, refund: kind === 'WITHDRAW_REFUND', withdraw: kind === 'WITHDRAW', source: null });
    }
  }

  // NoteFlow is kept by every server for itself; its item ids are the master's (only the master hands them out).
  const saves = [main, ...loadedSaves().filter(isSlaveOf(main))];
  let skipped = 0;
  for (const s of saves) {
    if (!hasFlow(s) || (scope.server !== null && scope.server !== s.name)) continue;
    for (const r of all(saveData(s), `SELECT ts, source, player, item, amount FROM note_flow WHERE 1 ${until} ORDER BY ts, id`, scope.to !== null ? { to: scope.to } : {})) {
      const ts = num(r.ts)!, each = worth.get(num(r.item)!), player = text(r.player);
      if (each === undefined) { if (inRange(ts)) skipped++; continue; }
      const source = String(r.source);
      moves.push({ ts, delta: big(r.amount)! * each, account: null, player: player && UUID.test(player) ? player : null, refund: false, withdraw: false,
        source: SOURCES.has(source) ? source : 'other' });
    }
  }

  // 2.1.2 (no NoteFlow) logged the amount asked for (WithdrawMoneyPacket.logMoneyWithdraw) and put notes that did not fit
  // back without a row (putRemainingItemsBack), so a withdrawal is cut by the positive gap of the check around it.
  // ponytail: any unlogged gain in the same snapshot interval counts as put-back; finer needs snapshots closer than the rows.
  let putBack = 0n;
  const found: BanknoteGap[] = [], appeared: BanknoteGap[] = [], tooLarge: BanknoteGap[] = [], estimated = new Set<number>();
  if (!hasFlow(main)) {
    const gains = allGaps().filter((g) => money.has(g.item) && g.difference > 0n);
    const left = new Map(gains.map((g) => [g, g.difference]));
    for (const m of moves) {
      const g = m.withdraw ? gains.find((x) => x.account === m.account && x.from < m.ts && m.ts <= x.to) : undefined;
      if (!g) continue;
      const cut = left.get(g)! < m.delta ? left.get(g)! : m.delta;
      left.set(g, left.get(g)! - cut);
      m.delta -= cut;
      if (inRange(m.ts)) { putBack += cut; estimated.add(m.account!); }
    }
    for (const [g, amount] of left) {
      if (amount > DEFAULT_RULES.balance.money && inRange(g.to) && (scope.to === null || g.to <= scope.to)) {
        found.push({ account: g.account, owner: person(owner.get(g.account)), from: g.from, to: g.to, amount });
      }
    }
    found.sort((a, b) => a.from - b.from || a.account - b.account);
  }
  moves.sort((a, b) => a.ts - b.ts); // stable: log rows before NoteFlow rows of the same millisecond
  // Notes can only come back if they were outside the bank: a gap above the notes outstanding at its start is too large.
  // ponytail: a ceiling; earlier gaps that could be notes do not lower it for later ones.
  let i = 0, before = 0n;
  for (const g of found) {
    for (; i < moves.length && moves[i]!.ts <= g.from; i++) before += moves[i]!.delta;
    (g.amount <= before ? appeared : tooLarge).push(g);
  }

  const ledger = { out: 0n, back: 0n };
  const flow = new Map<string, { source: string; created: bigint; destroyed: bigint }>();
  const accounts = new Map<number, BanknoteAccount>(), players = new Map<string, BanknotePlayer>();
  const steps: { account: bigint; item: bigint; time: number; v: bigint }[] = [];
  let outstanding = 0n;
  for (const m of moves) {
    outstanding += m.delta;
    steps.push({ account: 0n, item: 0n, time: m.ts, v: outstanding });
    if (!inRange(m.ts)) continue;
    const p = m.player === null ? null
      : players.get(m.player) ?? players.set(m.player, { player: { uuid: m.player, name: nameOf(m.player) }, out: 0n, back: 0n, created: 0n, destroyed: 0n, net: 0n, basis: 'estimate' }).get(m.player)!;
    if (p) p.net += m.delta;
    if (m.account === null) {
      const f = flow.get(m.source!) ?? flow.set(m.source!, { source: m.source!, created: 0n, destroyed: 0n }).get(m.source!)!;
      if (m.delta > 0n) { f.created += m.delta; if (p) p.created += m.delta; } else { f.destroyed -= m.delta; if (p) p.destroyed -= m.delta; }
      continue;
    }
    const a = accounts.get(m.account) ?? accounts.set(m.account, { account: m.account, owner: person(owner.get(m.account)), out: 0n, back: 0n, net: 0n,
      basis: estimated.has(m.account) ? 'estimate' : 'proven' }).get(m.account)!;
    a.net += m.delta;
    // A refund takes back part of a hand-out: it lowers out instead of counting as paid in.
    for (const x of p ? [ledger, a, p] : [ledger, a]) if (m.delta > 0n || m.refund) x.out += m.delta; else x.back -= m.delta;
  }

  const missing: string[] = [];
  const without = saves.filter((s) => !hasFlow(s)).map((s) => s.name);
  if (without.length) {
    missing.push(`${list(without)} ${without.length === 1 ? 'has' : 'have'} no banknote log (BankSystem 2.1.2 and older kept none), so notes made or destroyed there outside the bank (converter, villagers, creative mode, /give) are not counted.`);
  }
  // The refund and converter rows came with the same BankSystem change as NoteFlow (none of them is in 2.1.2).
  if (!hasFlow(main)) {
    missing.push('BankSystem 2.1.2 logged the amount a player asked to withdraw, also when notes that did not fit went back into the account, so the tool takes how far the balance actually fell (an estimate from the balance history).');
    if (appeared.length) missing.push('Money also appeared on accounts without a log row, each time at most the notes then outside the bank, so it could be notes paid back in through the ATM converter, which 2.1.2 did not log. It is not taken off the count.');
    if (tooLarge.length) missing.push('Other money that appeared without a log row is more than all notes outside the bank at that time: an admin action or another cause.');
    // Said once, and only when it matters: with no server chosen there is nothing to not apply.
    if (scope.server !== null && (appeared.length || tooLarge.length)) missing.push('The server filter does not apply to money that appeared without a log row: a gap between two snapshots belongs to no server.');
  }
  const absent = (main.knownSlaves ?? []).filter((n) => !saves.some((s) => s.name === n));
  if (absent.length) missing.push(`The ${absent.length === 1 ? 'slave' : 'slaves'} ${list(absent)} ${absent.length === 1 ? 'is' : 'are'} not loaded, so notes made or destroyed there outside the bank are not counted.`);

  const byNet = (a: { net: bigint }, b: { net: bigint }) => (a.net === b.net ? 0 : a.net > b.net ? -1 : 1);
  return {
    reason: null, outstanding, ledger, putBack, appeared, tooLarge, flow: [...flow.values()].sort((a, b) => (a.source < b.source ? -1 : 1)),
    accounts: [...accounts.values()].sort((a, b) => byNet(a, b) || a.account - b.account),
    players: [...players.values()].sort((a, b) => byNet(a, b) || (a.player.name < b.player.name ? -1 : 1)),
    // ponytail: one point per distinct millisecond (39 on the November copy); no screen draws it yet, thin it when one does.
    series: series(steps, scope), unclear, skipped, missing,
  };
}

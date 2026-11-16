// The check of value moved between servers. Each slave's TransferJournal rows and the master's ledger
// rows and TRANSFER_PARKED flags with the same transfer id are paired by that id alone, never by time, and every id is put
// into one class.
import type { DatabaseSync } from 'node:sqlite';
import type { SaveSummary, Scope, TransferClass, TransferItem, TransferRow, TransfersResult } from '../../shared/api.ts';
import { loadedSaves, mainData, mainSave, saveData } from '../workspace.ts';
import { noteWorth } from './check.ts';
import { all, big, names, num, text } from './db.ts';
import { change } from './players.ts';

const MIN = 60_000;
/** How long a slave keeps asking the master about an open transfer (TransferStatusRequest, TTL 10 minutes). */
export const IN_FLIGHT = 10 * MIN;
const FINAL = new Set(['CONFIRMED', 'DELIVERED', 'RETURNED', 'TIMED_OUT', 'FAILED']);
const STEPS = new Set(['REQUESTED', ...FINAL]);
/** Ledger kinds a master writes under a slave's transfer id, or under its own for a DROP. */
const SLAVE_KINDS = new Set(['DEPOSIT', 'WITHDRAW', 'WITHDRAW_REFUND', 'CONVERTER_DEPOSIT', 'CONVERTER_WITHDRAW', 'UPLOAD_DEPOSIT',
  'DOWNLOAD_WITHDRAW', 'CRAFT_CONSUME', 'CRAFT_OUTPUT', 'SHARE_TRADE', 'ACCOUNT_DELETE_PAYOUT', 'ACCOUNT_DELETE_LOSS', 'REFUND_LOST']);
const UUID_GLOB = '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-*-*-*-*';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLASSES: TransferClass[] = ['ok', 'parked', 'twice', 'lost', 'created', 'known-gap', 'data-gap', 'after-snapshot'];

/**
 * items_json of a journal row: {"<item id>":<raw amount>,...} as Gson writes it (TransferJournal.json), per item. Read with a
 * pattern, not JSON.parse, so amounts above 2^53 stay exact and no key can reach an object's prototype. null when it is not
 * that shape.
 */
export function readItems(json: string | null): Map<number, bigint> | null {
  if (json === null || json.length > 4096 || !/^\{(?:"-?\d{1,6}":-?\d{1,19}(?:,(?!\})|(?=\})))*\}$/.test(json)) return null;
  const items = new Map<number, bigint>();
  for (const m of json.matchAll(/"(-?\d{1,6})":(-?\d{1,19})/g)) items.set(Number(m[1]), (items.get(Number(m[1])) ?? 0n) + BigInt(m[2]!));
  return items;
}
/** Raw amounts per item; the key null is money (every banknote denomination and the base money item, folded into one). */
type Amounts = Map<number | null, bigint>;
const add = (m: Amounts, k: number | null, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

/** One journal row, read from a slave's cache. items: null when the row has none; undefined when they could not be read. */
interface Step { ts: number; step: string; direction: string | null; path: string | null; account: number | null; player: string | null;
  items: Map<number, bigint> | null | undefined; ledgerType: number | null; context: string | null }
/** change: what the row did to the balance; null when the save does not say (UNKNOWN_LEGACY, a rejected slave code). */
interface Row { id: number; ts: number; account: number; kind: string; item: number; amount: bigint; change: bigint | null; note?: string | null }
interface Flag { id: number; ts: number; account: number }

/** Both halves of one transfer id and what the saves around it say. */
export interface Pair {
  steps: Step[];
  rows: Row[];
  flags: Flag[];
  /** Whether the other half can be in the loaded data: null when it can, else why not. */
  gap: string | null;
  /** The older copy time of the saves the transfer touches. */
  copy: number | null;
  /** The items that are money: their amounts are folded into one (banknotes in the journal, the base item on the master). */
  money: ReadonlySet<number>;
  /** The master's ADMIN_UNLOCK rows of the transfer's account, which carry no transfer id. */
  unlocks?: Row[];
}

/**
 * What was sent and received per item, and the class. locked: what stays locked on the account because the master took
 * nothing; unlock: the ADMIN_UNLOCK row that likely released it. Pure, so the tests can give it any pair.
 */
export function classify(p: Pair): { items: TransferItem[]; class: TransferClass; why: string; locked: TransferRow['locked']; unlock: number | null } {
  const req = p.steps.find((s) => s.step === 'REQUESTED');
  const dir = req?.direction ?? p.steps.find((s) => s.direction)?.direction ?? null;
  const has = (step: string) => p.steps.some((s) => s.step === step);
  const start = Math.min(...p.steps.map((s) => s.ts), ...p.rows.map((r) => r.ts), ...p.flags.map((f) => f.ts));
  const key = (item: number) => (p.money.has(item) ? null : item);
  const fold = (into: Amounts, items: Map<number, bigint> | null | undefined, sign = 1n) => {
    for (const [i, v] of items ?? []) add(into, key(i), sign * v);
    return into;
  };
  // The master's side, signed: + paid into an account, - taken from one. A row of unknown direction counts the journal's way.
  const signed = (r: Row) => r.change ?? (dir === 'TO_MASTER' ? abs(r.amount) : -abs(r.amount));
  const net: Amounts = new Map();
  for (const r of p.rows) add(net, key(r.item), signed(r));
  const debited = p.rows.some((r) => signed(r) < 0n);
  const map = (m: Amounts, f: (v: bigint) => bigint): Amounts => new Map([...m].map(([k, v]) => [k, f(v)]));
  const result = (sent: Amounts, received: Amounts, cls: TransferClass, why: string, locked: Amounts = new Map(), unlock: number | null = null) => {
    const items = [...new Set([...sent.keys(), ...received.keys()])].sort((a, b) => (a ?? -1) - (b ?? -1))
      .map((item) => ({ item, sent: sent.get(item) ?? 0n, received: received.get(item) ?? 0n }));
    return { items, class: cls, why, locked: [...locked].map(([item, amount]) => ({ item, amount })), unlock };
  };
  const none: Amounts = new Map();

  if (p.steps.some((s) => s.items === undefined)) return result(none, none, 'data-gap', 'A journal row lists its items in a form this tool cannot read.');
  let sent: Amounts, received: Amounts, sender: boolean;
  if (!p.steps.length) {
    sent = map(net, (v) => (v < 0n ? -v : 0n));
    received = map(net, (v) => (v > 0n ? v : 0n));
    sender = debited;
  } else if (dir === 'TO_MASTER') {
    if (!req) return result(none, none, 'data-gap', 'The journal has no row for the start of this transfer.');
    const left = fold(new Map(), req.items);
    for (const s of p.steps.filter((x) => x.step === 'RETURNED')) fold(left, s.items === null ? req.items : s.items, -1n); // without items: all of it
    sent = map(left, (v) => (v > 0n ? v : 0n));
    received = net;
    sender = true;
  } else if (req?.path === 'DROP' || p.steps.some((s) => s.path === 'DROP')) {
    sent = map(net, (v) => -v);
    received = new Map();
    for (const s of p.steps.filter((x) => x.step === 'DELIVERED')) fold(received, s.items);
    sender = debited;
  } else {
    if (!req) return result(none, none, 'data-gap', 'The journal has no row for the start of this transfer.');
    sent = map(net, (v) => -v);
    received = has('DELIVERED') ? fold(new Map(), req.items) : new Map();
    sender = debited;
  }
  const keys = [...new Set([...sent.keys(), ...received.keys()])];
  const diff = (k: number | null) => (received.get(k) ?? 0n) - (sent.get(k) ?? 0n);

  const timedOut = has('TIMED_OUT');
  const settled = p.copy === null || start <= p.copy - IN_FLIGHT; // no longer in flight when the copies were taken
  const only = p.steps.length === 1 && !p.rows.length;
  // Known gaps: the mods move value here without the rows that would pair it. The un-debited craft
  // balances in the journal's terms (nothing debited, nothing delivered), so it is checked before "ok".
  if (only && dir === 'FROM_MASTER' && req?.ledgerType === 17 && settled) {
    return result(sent, received, 'known-gap', 'Crafting handed out the result before the master refused to take the ingredients; they stay locked for an admin.');
  }
  // Ok only when every item matches: raw units of different items cannot be added up.
  if (keys.every((k) => diff(k) === 0n) && !(dir === 'FROM_MASTER' && timedOut)) {
    return result(sent, received, 'ok', [...sent.values()].every((v) => v === 0n) ? 'Nothing moved: the master refused it, or nothing was left to hand out.' : 'Both sides agree.');
  }
  if (req && req.ledgerType === null) return result(sent, received, 'known-gap', 'A raw bank call: the master logs it without the transfer id.');
  if (only && dir === 'TO_MASTER' && req?.context === null && settled) {
    return result(sent, received, 'known-gap', 'A deposit from outside the bank\'s own blocks that the master refused: whether the caller kept the value is not logged.');
  }
  // BS-267: the master wrote down that notes it could not hand out were not booked back either. That is final, journal or not.
  const refundLost = p.rows.find((r) => r.kind === 'REFUND_LOST');
  if (refundLost) {
    const reason = /refund lost \((.+?)\):/.exec(refundLost.note ?? '')?.[1];
    return result(sent, received, 'lost', `Notes the master took from the account were not handed out, and their refund could not be booked back${reason ? ` (${reason})` : ''}: the value is gone.`);
  }
  if (p.gap !== null) return result(sent, received, 'data-gap', p.gap);
  const final = p.steps.some((s) => FINAL.has(s.step));
  if (p.copy !== null && (start > p.copy || (!final && start > p.copy - IN_FLIGHT))) {
    return result(sent, received, 'after-snapshot', 'It started shortly before or after one of the copies was taken, so the other side may not have it yet.');
  }
  // A slave's withdrawal through the terminal (WITHDRAW) or a download block (DOWNLOAD_WITHDRAW) whose answer never came.
  // The terminal leaves the items with the player. The download block does so since slaves report these parks to the
  // master (TRANSFER_PARKED with this id, BS-267); before, it took them back. The slave sends no unlock either way, so
  // what the master did not take stays locked, until an admin releases it (ADMIN_UNLOCK, which names no transfer).
  if (dir === 'FROM_MASTER' && timedOut && req?.path === 'ASYNC_BANK' && (req.ledgerType === 2 || req.ledgerType === 16)) {
    const asked = fold(new Map(), req.items);
    const reported = p.flags.length > 0, kept = req.ledgerType === 2 || reported;
    const same = (a: Amounts, b: Amounts) => [...new Set([...a.keys(), ...b.keys()])].every((k) => (a.get(k) ?? 0n) === (b.get(k) ?? 0n));
    const parkedAt = Math.min(...p.steps.filter((s) => s.step === 'TIMED_OUT').map((s) => s.ts));
    if (debited) {
      if (!kept) return result(sent, none, 'parked', 'The download block took the items back when no answer came, but the master took the payment: the player likely paid and got nothing.');
      return same(sent, asked) ? result(sent, asked, 'ok', 'The slave never heard back, but the master took the payment and the items stayed with the player: in order.')
        : result(sent, asked, 'parked', 'The slave never heard back; the items stayed with the player, and the master took a different amount than they were worth.');
    }
    const unlock = p.unlocks?.find((u) => u.ts >= parkedAt && asked.has(key(u.item)) && abs(u.amount) >= asked.get(key(u.item))!) ?? null;
    if (kept) {
      if (unlock) return result(none, asked, 'twice', 'The items stayed with the player, the master never took the payment, and an admin later released the locked amount: the player likely has the items and the money.', new Map(), unlock.id);
      const limit = reported ? '' : ' A lock freed without a log row (a refused craft could do that before slaves reported these parks) does not show here.';
      return result(none, asked, 'parked', `The items stayed with the player, but the master never took the payment: the amount stays locked on the account until an admin takes it.${limit}`, asked);
    }
    if (unlock) return result(none, none, 'ok', 'The download block took the items back, the master took nothing, and an admin later released the locked amount.', new Map(), unlock.id);
    return result(none, none, 'parked', 'The download block took the items back and the master took nothing: the amount stays locked on the account until an admin releases it.', asked);
  }
  if (timedOut || p.flags.length || p.rows.some((r) => r.kind === 'ACCOUNT_DELETE_LOSS')) {
    return result(sent, received, 'parked', 'The outcome was unknown on the server; the mod left it for an admin.');
  }
  if (keys.some((k) => diff(k) > 0n)) {
    return sender ? result(sent, received, 'twice', 'More arrived than was sent.')
      : result(sent, received, 'created', 'Value arrived that no server sent.');
  }
  return result(sent, received, 'lost', 'Value was sent and did not arrive, and nothing says it was given back.');
}
const abs = (v: bigint) => (v < 0n ? -v : v);

/** A slave of the loaded master, by the master id it names (or none). */
export const isSlaveOf = (main: SaveSummary) => (s: SaveSummary) => s.role === 'SLAVE' && (!s.masterUid || !main.serverUid || s.masterUid === main.serverUid);
const journal = (s: SaveSummary) => s.sources.find((x) => x.id === 'bankDiag')?.tables.find((t) => t.name === 'TransferJournal') ?? null;

/** Why nothing can be checked; null when something can. */
export function noTransfers(): string | null {
  const main = mainSave();
  if (!main) return 'No save with bank data is loaded, so no transfer can be checked.';
  const slaves = loadedSaves().filter(isSlaveOf(main));
  if (slaves.some((s) => journal(s) !== null)) return null;
  if (!slaves.length) {
    return main.role === 'STANDALONE' ? 'This is a single server: nothing moves between servers.'
      : 'No slave save is loaded. Every transfer is written down in a slave\'s journal, so add the slaves to check them.';
  }
  return 'The loaded slaves have no transfer journal. BankSystem 2.1.2 and older did not keep one, so nothing can be checked.';
}

const kept = new WeakMap<DatabaseSync, TransferRow[]>();

/** Every transfer id over all loaded data, classified, newest first. Kept per workspace (the master's cache database). */
export function allTransfers(): TransferRow[] {
  const db = mainData(), main = mainSave();
  if (!db || !main || noTransfers() !== null) return [];
  const done = kept.get(db);
  if (done) return done;

  const slaves = loadedSaves().filter(isSlaveOf(main));
  const ids = new Map<string, { steps: Step[]; server: string | null; rows: Row[]; flags: Flag[] }>();
  const entry = (id: string) => ids.get(id) ?? ids.set(id, { steps: [], server: null, rows: [], flags: [] }).get(id)!;
  for (const s of slaves) {
    if (!journal(s)) continue;
    for (const r of all(saveData(s), 'SELECT * FROM transfer_step ORDER BY ts, id')) {
      const id = text(r.transfer_id)!.toLowerCase(), step = text(r.step)!;
      if (!UUID.test(id) || !STEPS.has(step)) continue; // not written by the mod
      const e = entry(id), raw = text(r.items_json);
      e.server ??= s.name;
      e.steps.push({ ts: num(r.ts)!, step, direction: oneOf(r.direction, ['TO_MASTER', 'FROM_MASTER']), path: oneOf(r.path, ['ASYNC_BANK', 'CONVERTER_DEPOSIT', 'DROP']),
        account: num(r.account), player: text(r.player), items: raw === null ? null : (readItems(raw) ?? undefined), ledgerType: num(r.ledger_type), context: text(r.context) });
    }
  }
  const journaled = new Set(ids.keys());
  // The master's rows with a transfer id. Rows no loaded journal has are kept only for the kinds a slave transfer writes:
  // TRANSFER (fresh id, no journal) and the share stamper's rows are never part of one.
  for (const r of all(db, `SELECT id, ts, account, kind, item, amount, note, balance_after, lower(ref) AS ref FROM ledger
    WHERE ref GLOB '${UUID_GLOB}' AND kind NOT IN ('TRANSFER', 'SHARE_STAMP', 'SHARE_REDEEM') ORDER BY ts, id`)) {
    const ref = String(r.ref), kind = String(r.kind);
    if (!UUID.test(ref) || (!journaled.has(ref) && !SLAVE_KINDS.has(kind))) continue;
    const amount = big(r.amount)!;
    const note = text(r.note);
    entry(ref).rows.push({ id: num(r.id)!, ts: num(r.ts)!, account: num(r.account)!, kind, item: num(r.item)!, amount, change: change(kind, amount, note, big(r.balance_after)), note });
  }
  for (const r of all(db, `SELECT id, ts, account, lower(ref) AS ref FROM flag WHERE flag_type = 6 AND ref IS NOT NULL ORDER BY ts, id`)) {
    const ref = String(r.ref);
    if (ids.has(ref)) ids.get(ref)!.flags.push({ id: num(r.id)!, ts: num(r.ts)!, account: num(r.account)! });
  }

  // Where each side's data starts: the master's first row with a transfer id, each slave's first journal row.
  const masterFrom = num(all(db, `SELECT min(ts) AS t FROM ledger WHERE ref GLOB '${UUID_GLOB}'`)[0]!.t);
  const known = main.knownSlaves ?? null;
  const knownSaves = known?.map((name) => slaves.find((s) => s.name === name) ?? null) ?? null;
  const nameOf = names(db), money = new Set(noteWorth(db).keys());
  const unlocks = new Map<number, Row[]>();
  for (const r of all(db, "SELECT id, ts, account, item, amount FROM ledger WHERE kind = 'ADMIN_UNLOCK' ORDER BY ts, id")) {
    const row: Row = { id: num(r.id)!, ts: num(r.ts)!, account: num(r.account)!, kind: 'ADMIN_UNLOCK', item: num(r.item)!, amount: big(r.amount)!, change: 0n };
    (unlocks.get(row.account) ?? unlocks.set(row.account, []).get(row.account)!).push(row);
  }
  const owner = new Map(all(db, 'SELECT number, owner FROM main.account WHERE owner IS NOT NULL').map((r) => [num(r.number)!, String(r.owner)]));

  const out: TransferRow[] = [];
  for (const [id, e] of ids) {
    const times = [...e.steps.map((s) => s.ts), ...e.rows.map((r) => r.ts), ...e.flags.map((f) => f.ts)];
    const start = Math.min(...times), end = Math.max(...times);
    let gap: string | null = null, copy = main.lastPlayedMs;
    const older = (t: number | null) => (copy = copy === null ? t : t === null ? copy : Math.min(copy, t));
    if (e.server !== null) {
      const slave = slaves.find((s) => s.name === e.server)!;
      older(slave.lastPlayedMs);
      if (!e.rows.length && (masterFrom === null || masterFrom > start)) gap = `The master's log has no transfer ids from before ${new Date(start).toISOString().slice(0, 10)} on, so it cannot hold this one.`;
    } else if (knownSaves === null) {
      gap = 'No loaded journal has this id, and the master\'s files do not list its slaves, so the slave it came from may not be loaded.';
    } else {
      // Only on the master: the slave is not recorded, so every slave it knows must be loaded and cover the time.
      for (const [i, s] of knownSaves.entries()) {
        const from = s && journal(s)?.from;
        if (!s) gap ??= `No loaded journal has this id, and the slave "${known![i]}" is not loaded.`;
        else if (from === null || from === undefined || from > start) gap ??= `No loaded journal has this id, and the journal of "${s.name}" starts later.`;
        else older(s.lastPlayedMs);
      }
    }
    const req = e.steps.find((s) => s.step === 'REQUESTED') ?? e.steps[0];
    const account = req?.account ?? e.rows[0]?.account ?? null;
    const c = classify({ steps: e.steps, rows: e.rows, flags: e.flags, gap, copy, money, unlocks: account === null ? [] : unlocks.get(account) ?? [] });
    const player = e.steps.find((s) => s.player !== null && UUID.test(s.player))?.player ?? (account === null ? null : owner.get(account) ?? null);
    // With no journal row, a deletion payout or loss still names its way: its id is a slave's leg of the master's drop.
    const deletion = e.rows.some((r) => r.kind === 'ACCOUNT_DELETE_PAYOUT' || r.kind === 'ACCOUNT_DELETE_LOSS');
    out.push({
      id, start, end, direction: (req?.direction ?? (deletion ? 'FROM_MASTER' : null)) as TransferRow['direction'],
      path: (e.steps.find((s) => s.path)?.path ?? (deletion ? 'DROP' : null)) as TransferRow['path'],
      server: e.server, account, player: player === null ? null : { uuid: player, name: nameOf(player) }, steps: e.steps.slice(0, 50).map((s) => s.step),
      items: c.items, ledger: [...e.rows.map((r) => r.id), ...(c.unlock === null ? [] : [c.unlock])], flags: e.flags.map((f) => f.id),
      locked: c.locked, class: c.class, why: c.why,
    });
  }
  out.sort((a, b) => b.start - a.start || (a.id < b.id ? -1 : 1));
  kept.set(db, out);
  return out;
}
const oneOf = (v: unknown, list: string[]) => (typeof v === 'string' && list.includes(v) ? v : null);

export function transfers(scope: Scope): TransfersResult {
  const reason = noTransfers();
  const list = allTransfers().filter((t) => (scope.from === null || t.start >= scope.from) && (scope.to === null || t.start <= scope.to)
    && (scope.server === null || t.server === null || t.server === scope.server));
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<TransferClass, number>;
  for (const t of list) counts[t.class]++;
  return { transfers: list, counts, reason };
}

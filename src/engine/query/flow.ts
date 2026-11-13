// Where the money of an incident went (DESIGN_SPEC 6.6 and 8.10): per player and personal account, from the balance at the
// incident's start to the copy, every move of the money items sorted into a part. "unexplained" takes the rest, so it closes.
import type { BanknotesResult, FlowPart, MoneyFlow, RuleSettings, Scope } from '../../shared/api.ts';
import { mainData, mainSave } from '../workspace.ts';
import { banknotes, noteChange } from './banknotes.ts';
import { checkAll, moneyItems, read, unpaired, type Move } from './check.ts';
import { all, big, names, num } from './db.ts';
import { findings } from './findings.ts';
import { incidents } from './incidents.ts';
import { noteMatches } from './links.ts';
import { usualAt } from './markets.ts';
import { worldItems } from './world.ts';

const ALL: Scope = { from: null, to: null, server: null };
const TRANSFER = new Set(['TRANSFER', 'TRANSFER_IN', 'TRANSFER_OUT']);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const ZERO = { outside: 0n, inFiles: 0n, elsewhere: 0n, notFound: 0n, others: [] };

type Draft = Omit<FlowPart, 'side'>;
type Part = FlowPart;
const draft = (kind: FlowPart['kind'], player: string, account: number, more: Partial<Draft> = {}): Draft => ({
  kind, player, amount: 0n, basis: 'proven', market: null, other: null, incident: false, items: null, notes: null, accounts: [account], gap: null,
  records: { ledger: [], orders: [], findings: [] }, ...more,
});
const note = (d: Draft, m: Move) => (m.order ? d.records.orders : d.records.ledger).push(m.id);

/**
 * For the take-back (takeback.ts): start replaces the incident's start, players are followed besides the incident's, and
 * split keeps the parts per account and gap instead of merging them per player.
 */
export interface FlowOptions { start?: number; players?: string[]; split?: boolean }

export function moneyFlow(scope: Scope, incidentId: string, player: string | null, settings: RuleSettings, opts: FlowOptions = {}): MoneyFlow {
  const db = mainData(), main = mainSave();
  const legacy = main?.generation === 'legacy';
  const empty = (reason: string): MoneyFlow =>
    ({ reason, incident: null, players: [], player, accounts: [], parts: [], notes: ZERO, to: main?.lastPlayedMs ?? null, legacy, missing: [] });
  if (!db || !main) return empty('No save with bank data is loaded, so no money can be followed.');
  const inc = incidents(ALL, settings).incidents.find((i) => i.id === incidentId);
  if (!inc) return empty('This incident is not raised with the current rule settings.');
  const t0 = opts.start ?? inc.start, nameOf = names(db);
  const extra = (opts.players ?? []).filter((u) => !inc.players.some((p) => p.uuid === u)).map((uuid) => ({ uuid, name: nameOf(uuid) }));
  const owned = all(db, `SELECT number, owner FROM account WHERE owner IN (SELECT value FROM json_each(:p)) ORDER BY number`,
    { p: JSON.stringify([...inc.players, ...extra].map((p) => p.uuid)) }).map((r) => ({ account: num(r.number)!, player: String(r.owner) }));
  const players = [...inc.players, ...extra].filter((p) => owned.some((o) => o.player === p.uuid));
  if (!players.length) return { ...empty('None of the players of this incident has a personal account, so there is no balance to follow.'), incident: inc };

  const money = [...moneyItems(db)];
  const now = new Map(all(db, 'SELECT account, item, balance + locked AS v FROM balance').map((r) => [`${r.account}:${r.item}`, big(r.v)!]));
  const notesFrom = new Map<number | null, BanknotesResult>();
  const notesSince = (t0: number | null) => notesFrom.get(t0) ?? notesFrom.set(t0, banknotes({ from: t0 === null ? null : t0 + 1, to: null, server: null })).get(t0)!;
  const origin = (m: Move) => (m.server === '' ? main.name : m.server);
  // The server filter: an order without an origin is on no server, a log row without one is on every server (players.ts counts, onServer).
  const here = (m: Move) => scope.server === null || origin(m) === scope.server || (!m.order && m.server === null);

  const accounts: MoneyFlow['accounts'] = [];
  const parts: Part[] = [];
  for (const { account, player: uuid } of owned) {
    const checks = checkAll(account, { from: t0, to: null, server: null }, settings).get(account) ?? [];
    const { snaps, moves } = read(db, account);
    const mine: Part[] = [];
    const push = (side: 'in' | 'out', d: Draft) => { if (d.amount !== 0n) mine.push({ ...d, side }); };
    // The account's earliest start over its money items: undefined until set, null ("from the first record") is the earliest.
    let start = 0n, end = 0n, from: number | null | undefined;
    const unknown: number[] = [];
    for (const item of money) {
      const c = checks.find((x) => x.item === item);
      const t = c?.from ?? null;
      if (from === undefined || (from !== null && (t === null || t < from))) from = t;
      const begin = c?.start ?? 0n, is = now.get(`${account}:${item}`) ?? c?.is ?? begin;
      start += begin;
      end += is;
      const list = (moves.get(`${account}:${item}`) ?? []).filter((m) => t === null || m.ts > t);

      // Raw changes that log a trade a second time are paired away per snapshot interval, as the check does (check.ts gaps).
      const cuts = [...(snaps.get(`${account}:${item}`) ?? []).map(([ms]) => ms).filter((ms) => t === null || ms > t), Infinity];
      let k = 0;
      for (const cut of cuts) {
        let trades = 0n, raw = 0n;
        const ids: number[] = [];
        for (; k < list.length && list[k]!.ts <= cut; k++) {
          const m = list[k]!;
          if (m.how === 'trade') trades += m.amount;
          if (m.how === 'raw') { raw += m.amount; ids.push(m.id); }
        }
        const left = unpaired(trades, raw);
        if (left) push(left > 0n ? 'in' : 'out', draft('other', uuid, account, { amount: left < 0n ? -left : left, records: { ledger: ids, orders: [], findings: [] } }));
      }

      const markets = new Map<number, { cash: bigint; qty: bigint; paid: bigint; bought: bigint; d: Draft }>();
      const away = draft('other-server', uuid, account);
      const rows = new Map<string, Part>();
      for (const m of list) {
        if (m.how === 'unknown') unknown.push(m.id);
        if (m.how === 'raw' || m.how === 'unknown') continue;
        if (m.how === 'trade') {
          if (m.market === null) continue; // a goods move of a trade on a money item: none exist
          if (!here(m)) { away.amount += m.amount; note(away, m); continue; }
          const mk = markets.get(m.market) ?? markets.set(m.market, { cash: 0n, qty: 0n, paid: 0n, bought: 0n,
            d: draft('market', uuid, account, { market: m.market, incident: inc.markets.includes(m.market) }) }).get(m.market)!;
          mk.cash += m.amount;
          mk.qty += m.qty;
          if (m.qty > 0n) { mk.paid -= m.amount; mk.bought += m.qty; }
          note(mk.d, m);
          continue;
        }
        const side = m.amount > 0n ? 'in' : 'out';
        // Note rows: their amounts come from the banknote count below (cut by put-backs on 2.1.2); here only their ids.
        const [key, kind]: [string, FlowPart['kind']] = noteChange(m.kind, m.amount, m.note, null) ? ['notes', 'notes']
          : TRANSFER.has(m.kind) ? [`${side}:${m.other}`, side === 'in' ? 'received' : 'sent']
          : m.kind.startsWith('ADMIN_') ? [`admin:${side}`, 'admin'] : [`other:${side}`, 'other'];
        const d = rows.get(key) ?? rows.set(key, { ...draft(kind, uuid, account, kind === 'sent' || kind === 'received' ? { other: m.other } : {}), side }).get(key)!;
        note(d, m);
        if (kind !== 'notes') d.amount += m.amount < 0n ? -m.amount : m.amount;
      }
      mine.push(...rows.values()); // the notes part is filled per account below

      push(away.amount < 0n ? 'out' : 'in', { ...away, amount: away.amount < 0n ? -away.amount : away.amount });
      for (const [market, mk] of markets) {
        if (mk.cash >= 0n) { push('in', { ...mk.d, amount: mk.cash }); continue; }
        // A losing market: what the goods still held cost (average buying price), at most the loss; the rest was lost.
        const keptCost = mk.qty > 0n && mk.bought > 0n ? min(-mk.cash, (mk.qty * mk.paid) / mk.bought) : 0n;
        const usual = usualAt(market, t0); // the usual price before the incident (AT-45)
        push('out', { ...mk.d, kind: 'items', amount: keptCost, items: { qty: mk.qty, worth: usual === null ? null : (mk.qty * usual) / 100n } });
        push('out', { ...mk.d, kind: 'lost', amount: -mk.cash - keptCost, records: { ...mk.d.records } });
      }

      // 2.1.2 logged no admin action: money that went without a row (a negative gap above the threshold) was removed (an estimate).
      if (legacy) for (const g of c?.gaps ?? []) {
        if (g.difference < 0n) push('out', draft('removed', uuid, account, { amount: -g.difference, basis: 'estimate', gap: { from: g.from, to: g.to }, records: { ledger: [], orders: [], findings: [`balance:${account}:${item}@${g.from}`] } }));
      }
    }

    // Notes, once per account over all money items (the count sums them), and on 2.1.2 the money that appeared without a row.
    const bn = notesSince(from ?? null);
    const ba = bn.accounts.find((a) => a.account === account);
    const nd = mine.find((p) => p.kind === 'notes') ?? (ba ? (mine.push({ ...draft('notes', uuid, account), side: 'out' }), mine.at(-1)!) : undefined);
    if (nd && ba) {
      const net = ba.out - ba.back;
      Object.assign(nd, { side: net < 0n ? 'in' : 'out', amount: net < 0n ? -net : net, basis: ba.basis, notes: { out: ba.out, back: ba.back } });
    }
    for (const [list, kind] of [[bn.appeared, 'appeared'], [bn.tooLarge, 'added']] as const) {
      for (const g of list) if (g.account === account) {
        push('in', draft(kind, uuid, account, { amount: g.amount, basis: 'estimate', records: { ledger: [], orders: [], findings: money.map((i) => `balance:${account}:${i}@${g.from}`) } }));
      }
    }

    const kept = mine.filter((p) => p.amount !== 0n);
    const sum = kept.reduce((s, p) => s + (p.side === 'in' ? p.amount : -p.amount), 0n);
    const rest = end - start - sum;
    if (rest !== 0n || unknown.length) {
      kept.push({ ...draft('unexplained', uuid, account, { amount: rest < 0n ? -rest : rest, basis: kept.some((p) => p.basis === 'estimate') ? 'estimate' : 'proven' }),
        side: rest < 0n ? 'out' : 'in', records: { ledger: unknown, orders: [], findings: [] } });
    }
    kept.unshift({ ...draft('start', uuid, account, { amount: start }), side: 'in' });
    kept.push({ ...draft('now', uuid, account, { amount: end }), side: 'out' });
    parts.push(...kept);
    accounts.push({ account, player: uuid, from: from ?? null, start, now: end });
  }

  // The incident's findings, on the parts they are about (balance findings by their id, which names account, item and gap).
  // A balance finding on a gap that is a part of its own goes there, even when the incident does not hold it (a gap that
  // began before the incident's start); any other balance finding of the incident goes to the account's "unexplained".
  const ids = new Set(inc.findings), known = findings(ALL, settings).findings, exists = new Set(known.map((f) => f.id));
  for (const p of parts) p.records.findings = p.records.findings.filter((id) => exists.has(id));
  const claimed = new Set(parts.flatMap((p) => p.records.findings));
  for (const f of known) {
    if (!ids.has(f.id) || claimed.has(f.id)) continue;
    for (const p of parts) {
      const mine = f.players.some((x) => x.uuid === p.player) || f.accounts.some((a) => p.accounts.includes(a));
      const about = p.market !== null ? f.markets.includes(p.market)
        : f.rule === 'balance' ? p.kind === 'unexplained' && f.accounts.some((a) => p.accounts.includes(a))
        : f.rule === 'banknotes' ? p.kind === 'notes' : f.rule === 'transfer' ? p.kind === 'sent' || p.kind === 'received' : false;
      if (mine && about) p.records.findings.push(f.id);
    }
  }

  // Merged per player, kind, side, market and other account.
  const merged = new Map<string, FlowPart>();
  for (const p of parts) {
    const key = [p.player, p.kind, p.side, p.market, p.other].join('|');
    const m = merged.get(key);
    if (!m) { merged.set(key, { ...p, accounts: [...p.accounts], records: { ledger: [...p.records.ledger], orders: [...p.records.orders], findings: [...p.records.findings] } }); continue; }
    m.amount += p.amount;
    if (p.basis === 'estimate') m.basis = 'estimate';
    m.accounts.push(...p.accounts.filter((a) => !m.accounts.includes(a)));
    m.records.ledger.push(...p.records.ledger);
    m.records.orders.push(...p.records.orders);
    m.records.findings.push(...p.records.findings.filter((id) => !m.records.findings.includes(id)));
    if (m.items && p.items) m.items = { qty: m.items.qty + p.items.qty, worth: m.items.worth === null || p.items.worth === null ? null : m.items.worth + p.items.worth };
    if (m.notes && p.notes) m.notes = { out: m.notes.out + p.notes.out, back: m.notes.back + p.notes.back };
  }

  // Where the notes still outside are (estimates), for the chosen players as one: notes one of them took out and another
  // paid in are not outside any more. Their own files first, then the notes found anywhere else, the rest not found.
  // With one player chosen only the first split: notes found elsewhere are one pool every player's view could claim.
  const chosen = player === null ? players.map((p) => p.uuid) : [player];
  const world = worldItems();
  const own = world.players.filter((w) => chosen.includes(w.player.uuid)).reduce((s, w) => s + w.notes, 0n);
  const incidentFiles = world.players.filter((w) => players.some((p) => p.uuid === w.player.uuid)).reduce((s, w) => s + w.notes, 0n);
  let outside = 0n;
  for (const p of merged.values()) if (chosen.includes(p.player)) outside += p.kind === 'notes' ? (p.side === 'out' ? p.amount : -p.amount) : p.kind === 'appeared' ? -p.amount : 0n;
  if (outside < 0n) outside = 0n;
  // Notes they took out after the start that another player likely paid in (a Likely note link, DESIGN_SPEC 8.9).
  const others: MoneyFlow['notes']['others'] = [];
  for (const m of noteMatches(ALL)) {
    if (!chosen.includes(m.out) || chosen.includes(m.in) || m.withdrawn[0]!.ts <= t0 || outside === 0n) continue;
    const amount = min(m.amount, outside);
    outside -= amount;
    const o = others.find((x) => x.player.uuid === m.in) ?? (others.push({ player: { uuid: m.in, name: nameOf(m.in) }, amount: 0n }), others.at(-1)!);
    o.amount += amount;
  }
  const inFiles = min(outside, own), elsewhere = min(outside - inFiles, world.notes > incidentFiles ? world.notes - incidentFiles : 0n);
  const notes = player === null ? { outside, inFiles, elsewhere, notFound: outside - inFiles - elsewhere, others } : { outside, inFiles, elsewhere: null, notFound: null, others };

  const missing: string[] = [];
  if (legacy) {
    missing.push('BankSystem 2.1.2 logged no admin action and no note paid in through the ATM converter: money that came or went without a log row is taken from the gaps between snapshots, an estimate.');
  }
  if (scope.server !== null) missing.push('The server filter applies to trading only: trading on other servers is shown as one part. Bank rows and gaps belong to every server.');
  if (world.reason) missing.push(`Where the notes are now is not known: ${world.reason}`);
  return {
    reason: null, incident: inc, players, player, accounts: accounts.filter((a) => chosen.includes(a.player)),
    parts: (opts.split ? parts : [...merged.values()]).filter((p) => chosen.includes(p.player)), notes, to: main.lastPlayedMs, legacy, missing,
  };
}

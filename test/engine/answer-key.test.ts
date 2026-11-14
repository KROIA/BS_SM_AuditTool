// AT-48: the BS-269 fixture set (a master and a slave played by the BankSystem and StockMarket autotests) against its
// answer key. The set is loaded once as world folders and once as the mods' audit exports; every rule runs and each key
// case, the balances, the banknote places, the links and the take-back are checked. Findings and admin events the key
// does not list fail nothing: they are printed as "not in the key". Skipped without the set: AUDIT_FIXTURE, else
// ../autotest-out/fixtures/bs269 (kept by run_matrix --fixture bs269).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { addSave, init } from '../../src/engine/workspace.ts';
import { DEFAULT_RULES, type AdminEvent, type Finding, type LinkStrength, type Scope } from '../../src/shared/api.ts';

const DIR = path.resolve(process.env.AUDIT_FIXTURE ?? '../autotest-out/fixtures/bs269');
const KEY_FILE = path.join(DIR, 'answer-key.json');
const ALL: Scope = { from: null, to: null, server: null };

interface KeyCase {
  id: string; expect: 'flag' | 'clean'; rule: string; subject: string | null; item: string | null; window: { from: number; to: number } | null;
  amount: string | null; tolerance: string | null; note: string | null;
  transfer: { id: string; direction: string; path: string; class: string; sent: Record<string, string>; received: Record<string, string> } | null;
  records: { orders: string[]; ledger: string[]; flags: string[]; transfers: string[] };
}
interface Key {
  format: number;
  servers: { role: string; worldFolder: string | null; exportFolder: string | null }[];
  players: { name: string; uuid: string }[];
  cases: KeyCase[];
  balances: { account: number; item: string; balance: string; locked: string }[];
  banknotes: { player: string; place: string; raw: string }[];
  links: { a: string; b: string; strength: LinkStrength | 'none'; way: 'account' | 'transfer' | 'notes' | 'market'; item: string | null }[];
  takeBack: { cutoff: number; account: number; keep: string; take: string; items: { item: string; remove: string }[] }[];
}
const key: Key | null = fs.existsSync(KEY_FILE) ? JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) : null;

const PLAYER_RULES = new Set(['round-trip', 'order-rate', 'hour-profit', 'order-ledger', 'market-alert']);
const MARKET_RULES = new Set(['far-price', 'price-spike']);
const ACCOUNT_RULES = new Set(['balance', 'bank-flag']);
const WAY: Record<Key['links'][number]['way'], LinkStrength> = { account: 'proven', transfer: 'proven', notes: 'likely', market: 'weak' };
const abs = (v: bigint) => (v < 0n ? -v : v);
const subset = (want: string[], have: number[]) => want.every((w) => have.includes(Number(w)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key's amount against the tool's: raw whole numbers exactly (or within the tolerance), decimals within 0.01. Signs aside. */
function amountOk(c: KeyCase, v: bigint | number | null | undefined): boolean {
  if (c.amount === null) return true;
  if (v === null || v === undefined) return false;
  if (c.amount.includes('.') || typeof v === 'number') return Math.abs(Math.abs(Number(v)) - Math.abs(Number(c.amount))) <= Number(c.tolerance ?? '0.01');
  return abs(abs(v) - abs(BigInt(c.amount))) <= BigInt(c.tolerance ?? '0');
}

async function until(ok: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !ok();) {
    assert.ok(Date.now() < end, 'the region scan did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function check(t: TestContext, k: Key, mode: 'world' | 'export') {
  const items = api.items();
  const itemId = (name: string) => {
    const i = items.find((x) => x.name === name);
    assert.ok(i, `item ${name} is not in the save's item list`);
    return i.id;
  };
  /** Money of every denomination folds into one, as the transfer list does. */
  const transferItem = (name: string) => {
    const id = itemId(name);
    return items.find((x) => x.id === id)!.money ? null : id;
  };
  const uuidOf = (who: string) => (UUID.test(who) ? who.toLowerCase() : k.players.find((p) => p.name === who)?.uuid.toLowerCase() ?? who);
  const all = api.findings(ALL, DEFAULT_RULES).findings;
  const admin = api.adminEvents(ALL);
  const transfers = api.transfers(ALL).transfers;
  const keyed = new Set<string>(), keyedAdmin = new Set<number>();

  for (const c of k.cases) {
    const [base, kind] = c.rule.split(':') as [string, string | undefined];
    const skip = mode === 'export' && base === 'banknotes' ? 'an export carries no player files or regions to count notes in' : false;
    await t.test(`${c.id} (${c.rule}${c.subject === null ? '' : ` ${c.subject}`})`, { skip }, () => {
      const inWindow = (s: number, e: number) => !c.window || (s <= c.window.to && e >= c.window.from);
      const market = () => (c.subject !== null && /^\d+$/.test(c.subject) ? Number(c.subject) : itemId(c.subject ?? c.item!));

      if (base === 'admin') {
        // The bank's audit log writes whole seconds: an event stamped 12:00:05 happened somewhere in 12:00:05.000-.999.
        const hits = admin.filter((e) => e.type === kind && (c.subject === null || e.account === Number(c.subject)) && inWindow(e.time, e.time + 999));
        hits.forEach((e) => keyedAdmin.add(e.id));
        const ok = (e: AdminEvent) => amountOk(c, e.amount) && subset(c.records.ledger, e.ledgerId === null ? [] : [e.ledgerId]);
        const seen = hits.map((e) => `#${e.id} ${e.type} account ${e.account} at ${e.time} amount ${e.amount} ledger ${e.ledgerId}`).join('; ') || 'none';
        if (c.expect === 'flag') assert.ok(hits.some(ok), `no matching admin event; seen: ${seen}`);
        else assert.equal(hits.length, 0, `admin events where none should be: ${seen}`);
        return;
      }
      if (base === 'market') {
        const m = api.markets(ALL).find((x) => x.item === market());
        assert.ok(m, `market ${c.subject} is not in the Markets list`);
        assert.equal(m.price, null, 'a deleted market has no price');
        if (c.amount !== null) assert.equal(m.orders, Number(c.amount), 'order count');
        return;
      }
      if (!['round-trip', 'order-rate', 'hour-profit', 'far-price', 'price-spike', 'order-ledger', 'balance', 'bank-flag', 'market-alert', 'transfer', 'banknotes', 'last-save'].includes(base)) {
        assert.fail(`rule ${c.rule} is unknown to the tool`);
      }

      const about = (f: Finding) => {
        if (f.rule !== base) return false;
        if (base === 'bank-flag' && kind !== undefined && f.facts.flagType !== Number(kind)) return false;
        if (base === 'market-alert' && kind !== undefined && f.facts.kind !== kind) return false;
        if (c.subject === null) return true;
        if (PLAYER_RULES.has(base)) return f.players.some((p) => p.uuid.toLowerCase() === c.subject!.toLowerCase());
        if (MARKET_RULES.has(base)) return f.markets.includes(market());
        if (ACCOUNT_RULES.has(base)) return f.accounts.includes(Number(c.subject));
        if (base === 'transfer') return f.facts.transferId === c.subject;
        return true;
      };
      const hits = all.filter((f) => about(f) && inWindow(f.start, f.end));
      hits.forEach((f) => keyed.add(f.id));
      const value = (f: Finding) => (base === 'market-alert' ? (f.facts.amount as bigint | null) : f.measured.value);
      const ok = (f: Finding) => amountOk(c, value(f)) && subset(c.records.orders, f.records.orders) && subset(c.records.ledger, f.records.ledger)
        // Other rules name a transfer through its ledger rows (a last-save finding's rows carry the refs), checked above.
        && subset(c.records.flags, f.records.flags) && (base !== 'transfer' || c.records.transfers.every((id) => id === f.facts.transferId));
      const seen = hits.map((f) => `${f.id} ${f.start}..${f.end} value ${value(f)} orders [${f.records.orders}] ledger [${f.records.ledger}] flags [${f.records.flags}]`).join('; ') || 'none';
      if (c.expect === 'flag') assert.ok(hits.some(ok), `no matching finding; seen: ${seen}`);
      else assert.equal(hits.length, 0, `findings where none should be: ${seen}`);

      if (c.transfer) {
        const row = transfers.find((x) => x.id === c.transfer!.id);
        assert.ok(row, `transfer ${c.transfer.id} is not on the transfer list`);
        assert.deepEqual([row.class, row.direction, row.path], [c.transfer.class, c.transfer.direction, c.transfer.path], row.why);
        const fold = (m: Record<string, string>) => {
          const out = new Map<number | null, bigint>();
          for (const [name, raw] of Object.entries(m)) out.set(transferItem(name), (out.get(transferItem(name)) ?? 0n) + BigInt(raw));
          return [...out].filter(([, v]) => v !== 0n).sort();
        };
        const have = (side: 'sent' | 'received') => row.items.filter((i) => i[side] !== 0n).map((i) => [i.item, i[side]] as [number | null, bigint]).sort();
        assert.deepEqual(have('sent'), fold(c.transfer.sent), 'sent');
        assert.deepEqual(have('received'), fold(c.transfer.received), 'received');
      }
    });
  }

  for (const f of all) if (!keyed.has(f.id)) t.diagnostic(`not in the key: ${f.id} (${f.level}) ${f.start}..${f.end} value ${f.measured.value} accounts [${f.accounts}] players [${f.players.map((p) => p.name)}]`);
  const loose = new Map<string, number>();
  for (const e of admin) if (!keyedAdmin.has(e.id)) loose.set(e.type, (loose.get(e.type) ?? 0) + 1);
  for (const [type, n] of loose) t.diagnostic(`not in the key: ${n} admin event(s) ${type}`);

  await t.test('balances (free and locked per account and item)', () => {
    // Stamped shares of different companies share one name and have an id each: the key lists them by name, so the
    // slots of every id with that name are compared as a set, empty ones left out on both sides.
    const wrong: string[] = [];
    const groups = new Map<string, string[]>();
    for (const b of k.balances) groups.set(`${b.account} ${b.item}`, [...groups.get(`${b.account} ${b.item}`) ?? [], `${b.balance} / ${b.locked}`]);
    for (const [at, want] of groups) {
      const [account, name] = at.split(' ') as [string, string];
      const ids = new Set(items.filter((x) => x.name === name).map((x) => x.id));
      assert.ok(ids.size, `item ${name} is not in the save's item list`);
      const have = (api.account(Number(account), ALL)?.items ?? []).filter((i) => ids.has(i.item)).map((i) => `${i.balance} / ${i.locked}`);
      const used = (l: string[]) => l.filter((v) => v !== '0 / 0').sort();
      if (JSON.stringify(used(have)) !== JSON.stringify(used(want))) wrong.push(`account ${at}: free / locked ${used(have).join(', ') || 'none'}, key ${used(want).join(', ') || 'none'}`);
    }
    assert.deepEqual(wrong, []);
  });

  await t.test('banknote places', { skip: mode === 'export' ? 'an export carries no player files or regions' : false }, () => {
    const world = api.worldItems();
    const want = new Map<string, bigint>();
    for (const n of k.banknotes) {
      const at = n.place.startsWith('container@') ? n.place : `${uuidOf(n.player)} ${n.place}`;
      want.set(at, (want.get(at) ?? 0n) + BigInt(n.raw));
    }
    const wrong: string[] = [];
    for (const [at, raw] of want) {
      let got: bigint | null = null;
      if (at.startsWith('container@')) {
        const [x, y, z] = at.slice('container@'.length).split(',').map(Number);
        got = world.places.filter((p) => p.x === x && p.y === y && p.z === z).reduce((a, p) => a + p.notes, 0n);
      } else {
        const [uuid, place] = at.split(' ') as [string, string];
        const p = world.players.find((x) => x.player.uuid.toLowerCase() === uuid);
        if (place === 'inventory') got = p?.inventory ?? 0n;
        else if (place === 'enderchest') got = p?.enderChest ?? 0n;
        else t.diagnostic(`banknote place not checked: ${at}`);
      }
      if (got !== null && got !== raw) wrong.push(`${at}: ${got}, key ${raw}`);
    }
    assert.deepEqual(wrong, []);
  });

  await t.test('links', () => {
    const wrong: string[] = [];
    for (const l of k.links) {
      const other = api.links(l.a.toLowerCase(), ALL).find((x) => x.player.uuid.toLowerCase() === l.b.toLowerCase());
      const way = other?.ways.find((w) => w.kind === l.way && (w.kind !== 'market' || w.item === itemId(l.item!)) && (w.kind !== 'notes' || w.tookOut));
      const what = `${l.a} -> ${l.b} by ${l.way}${l.item ? ` ${l.item}` : ''}`;
      if (l.strength === 'none') {
        if (way) wrong.push(`${what}: linked, key says not`);
      } else if (!way) wrong.push(`${what}: not linked (${other ? other.ways.map((w) => w.kind).join(', ') : 'no link at all'})`);
      else if (WAY[l.way] !== l.strength) wrong.push(`${what}: the tool calls this way ${WAY[l.way]}, key ${l.strength}`);
    }
    assert.deepEqual(wrong, []);
  });

  await t.test('take-back', () => {
    const incidents = api.incidents(ALL, DEFAULT_RULES).incidents;
    const wrong: string[] = [];
    for (const e of k.takeBack) {
      const row = incidents.map((i) => api.takeBack(i.id, { kind: 'custom', at: e.cutoff }, DEFAULT_RULES).rows.find((r) => r.account === e.account)).find((r) => r);
      if (!row) {
        wrong.push(`account ${e.account}: in no incident's take-back`);
        continue;
      }
      if (row.keep !== BigInt(e.keep) || row.take !== BigInt(e.take)) wrong.push(`account ${e.account}: keep ${row.keep} take ${row.take}, key ${e.keep} / ${e.take}`);
      for (const i of e.items) {
        const got = row.items.find((x) => x.item === itemId(i.item))?.remove ?? 0n;
        if (got !== BigInt(i.remove)) wrong.push(`account ${e.account} ${i.item}: remove ${got}, key ${i.remove}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
}

for (const mode of ['world', 'export'] as const) {
  test(`the BS-269 fixture set as ${mode} folders against its answer key`, { skip: key ? false : `no fixture set at ${DIR}` }, async (t) => {
    const k = key!;
    assert.equal(k.format, 1, 'answer-key format');
    init(fs.mkdtempSync(path.join(os.tmpdir(), `audittool-bs269-${mode}-`)));
    const master = (s: Key['servers'][number]) => (s.role.toUpperCase() === 'MASTER' ? 0 : 1);
    for (const s of [...k.servers].sort((a, b) => master(a) - master(b))) {
      const folder = mode === 'world' ? s.worldFolder : s.exportFolder;
      if (folder) addSave(path.join(DIR, folder));
    }
    if (mode === 'world') {
      api.startScan();
      await until(() => !api.scanStatus().running, 600_000);
    }
    await check(t, k, mode);
  });
}

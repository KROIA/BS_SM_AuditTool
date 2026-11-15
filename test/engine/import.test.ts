import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { api } from '../../src/engine/api.ts';
import { readChunks } from '../../src/engine/save/files.ts';
import { importSave } from '../../src/engine/save/import.ts';
import { isCompound, num } from '../../src/engine/save/nbt.ts';
import type { SaveSummary } from '../../src/shared/api.ts';
import { ACCOUNT_ORDER, ALERT, ALIAS, buildFixtures, EXPORT, COMPANY, GONE, ITEM, MINECRAFT, NOTE_FLOW, PLAYERS, SHARED, T0, uuidText, VOUCHER, type Fixtures } from '../fixtures/build.ts';

const MIN = 60_000;
let fx: Fixtures;
let cacheDir: string;
before(() => {
  fx = buildFixtures(fs.mkdtempSync(path.join(os.tmpdir(), 'audittool-import-')));
  cacheDir = path.join(fx.root, 'cache');
  fs.mkdirSync(cacheDir);
});
after(() => fs.rmSync(fx.root, { recursive: true, force: true }));

let n = 0;
const load = (dir: string) => {
  const cache = path.join(cacheDir, `${++n}.db`);
  return { save: importSave(dir, cache), cache };
};
const status = (s: SaveSummary) => s.sources.map((x) => `${x.id}:${x.status}`);
const tables = (s: SaveSummary, source: string) => s.sources.find((x) => x.id === source)!.tables;
const rowsOf = (s: SaveSummary, source: string) => Object.fromEntries(tables(s, source).map((t) => [t.name, t.rows]));
const spansOf = (s: SaveSummary) => Object.fromEntries(s.sources.flatMap((x) => x.tables.map((t) => [t.name, [t.from, t.to]])));
/** Every file below dir with its size and time of last change. */
const listing = (dir: string) =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).sort().map((f) => { const s = fs.statSync(path.join(dir, f)); return `${f} ${s.size} ${s.mtimeMs}`; });
const query = (cache: string, sql: string) => {
  const db = new DatabaseSync(cache, { readOnly: true, readBigInts: true });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r })) as Record<string, bigint | string | null>[]; // plain objects, for deepEqual
  } finally {
    db.close();
  }
};

test('the master: role, format, every table with the rows the builder wrote, and the time each covers', () => {
  const { save } = load(fx.master);
  assert.equal(save.role, 'MASTER');
  assert.equal(save.roleAssumed, false);
  assert.equal(save.generation, 'current');
  assert.equal(save.name, 'survival-main');
  assert.equal(save.serverUid, 'f0000000-0000-4000-8000-000000000001');
  assert.deepEqual(status(save), ['bank:read', 'market:read', 'bankDiag:read', 'marketDiag:read', 'audit:read']);
  const w = fx.rows.master!;
  assert.deepEqual(rowsOf(save, 'market'), { MarketPrice: 8 * 160, OrderHistory: 86 });
  assert.deepEqual(rowsOf(save, 'market'), { MarketPrice: w.MarketPrice, OrderHistory: w.OrderHistory });
  assert.deepEqual(rowsOf(save, 'bank'), { TransactionLog: w.TransactionLog, BalanceHistory: w.BalanceHistory, SuspicionFlag: w.SuspicionFlag });
  assert.deepEqual(rowsOf(save, 'bankDiag'), { TransferJournal: 0, NoteFlow: w.NoteFlow, Meta: 3 });
  assert.deepEqual(rowsOf(save, 'marketDiag'), { OrderOrigin: w.OrderOrigin, TradeAlert: w.TradeAlert, Meta: 2 });
  assert.ok(save.sources.every((s) => s.tables.every((t) => t.lostIds === 0)));
  assert.deepEqual(spansOf(save), {
    MarketPrice: [T0, T0 + 159 * MIN],
    OrderHistory: [T0 + 5 * MIN + 1200, T0 + 130 * MIN + 5300],
    TransactionLog: [T0 - 24 * 60 * MIN, T0 + 130 * MIN + 5300],
    BalanceHistory: [T0 - 24 * 60 * MIN, T0 + 131 * MIN],
    SuspicionFlag: [T0 + 45 * MIN, T0 + 70 * MIN + 600],
    TransferJournal: [null, null],
    NoteFlow: [T0 + 52 * MIN, T0 + 69 * MIN],
    Meta: [null, null], // tables without a time column
    OrderOrigin: [null, null],
    TradeAlert: [ALERT.pump, ALERT.noPrice],
    AuditLog: [T0 + 30 * MIN, T0 + 129 * MIN], // whole seconds: the log drops the milliseconds
  });
  const day = (ms: number) => ms - (ms % 86_400_000);
  const days = Object.fromEntries(save.sources.flatMap((x) => x.tables.map((t) => [t.name, t.days])));
  assert.deepEqual(days.MarketPrice, [[day(T0), 8 * 160]]);
  assert.deepEqual(days.BalanceHistory!.map(([d]) => d), [day(T0) - 86_400_000, day(T0)]);
  assert.equal(days.BalanceHistory!.reduce((s, [, n]) => s + n, 0), w.BalanceHistory);
  assert.deepEqual(days.Meta, []);
  assert.equal(save.players, 6);
  assert.equal(save.accounts, ACCOUNT_ORDER.length);
  assert.equal(save.bankVersion, '2.2.0');
  assert.equal(save.lastPlayedMs, fx.lastPlayed['survival-main']);
  assert.equal(save.minecraft, MINECRAFT);
  assert.deepEqual([save.exported, save.marketVersion], [false, null]); // a plain copy: no manifest, and nothing else names the market version
  assert.deepEqual(save.warnings, []);
});

test('a slave is named after its slave id and is expected to have only the journal file', () => {
  const { save } = load(fx.slaves[0]!);
  assert.equal(save.role, 'SLAVE');
  assert.equal(save.name, 'mining-1');
  assert.equal(save.masterUid, 'f0000000-0000-4000-8000-000000000001');
  assert.equal(save.generation, 'current');
  assert.deepEqual(status(save), ['bank:none', 'market:none', 'bankDiag:read', 'marketDiag:none', 'audit:none']);
  assert.deepEqual(rowsOf(save, 'bankDiag'), { TransferJournal: 29, NoteFlow: NOTE_FLOW['mining-1'].length, Meta: 2 }); // 4 of the plain deposits, 25 of the transfer cases
  assert.deepEqual([save.players, save.accounts, save.bankVersion], [0, 0, null]);
  assert.equal(save.lastPlayedMs, fx.lastPlayed['mining-1']);
  // Its playerdata holds a cut-off file and one that is no NBT (test/engine/world.test.ts).
  assert.deepEqual(save.warnings, ['2 player files could not be read (damaged, not NBT, too large or nested too deep). What those players carry is not counted.']);
});

test('an old 2.1.2 save: recognised as such, role assumed, and no complaint about files that version never wrote', () => {
  const { save } = load(path.join(fx.legacy, 'data')); // the data folder itself may be picked too
  assert.equal(save.generation, 'legacy');
  assert.equal(save.role, 'MASTER');
  assert.equal(save.roleAssumed, true);
  assert.equal(save.name, 'old-world');
  assert.deepEqual(status(save), ['bank:read', 'market:read', 'bankDiag:none', 'marketDiag:none', 'audit:none']);
  const w = fx.rows.legacy!;
  assert.deepEqual(rowsOf(save, 'bank'), { TransactionLog: w.TransactionLog, BalanceHistory: w.BalanceHistory });
  assert.deepEqual(rowsOf(save, 'market'), { MarketPrice: w.MarketPrice, OrderHistory: w.OrderHistory });
  assert.equal(save.bankVersion, '2.1.2');
  assert.equal(save.lastPlayedMs, fx.lastPlayed['old-world']);
  assert.equal(save.warnings.length, 1);
  assert.match(save.warnings[0]!, /no server identity file/);
});

test('the NBT files in the cache: names, the money item, aliases, company accounts and exact balances', () => {
  const { cache } = load(fx.master);
  const players = query(cache, 'SELECT name, bank_admin, market_admin FROM player ORDER BY name');
  assert.deepEqual(players.map((p) => p.name), Object.keys(PLAYERS).sort());
  assert.deepEqual(players.filter((p) => p.bank_admin === 1n && p.market_admin === 1n).map((p) => p.name), ['AdmiralNoor']);

  const items = new Map(query(cache, 'SELECT id, name, money FROM item').map((i) => [Number(i.id), i]));
  assert.deepEqual([...items.values()].filter((i) => i.money === 1n).map((i) => Number(i.id)), [ITEM.money]);
  assert.equal(items.get(VOUCHER)!.name, 'banksystem:money'); // same item, but with components: not money
  assert.equal(items.get(ALIAS.from)!.name, 'minecraft:coal');
  assert.equal(items.get(GONE.id)!.name, GONE.name);

  // Balances equal what the bank database ends with, to the last digit, with the old coal id folded into the current one.
  const balances = new Map(query(cache, 'SELECT account, item, balance FROM balance').map((b) => [`${b.account}:${b.item}`, b.balance]));
  assert.deepEqual(balances, fx.balances.master);
  assert.equal(balances.get(`${COMPANY.account}:${ITEM.money}`), COMPANY.start);
  assert.equal(balances.get(`${PLAYERS.Brindle.account}:${ITEM.coal}`), 9600n);
  assert.deepEqual(query(cache, `SELECT * FROM balance WHERE item = ${ALIAS.from}`), []);

  assert.deepEqual(query(cache, 'SELECT number FROM account WHERE company IS NOT NULL').map((a) => a.number), [BigInt(COMPANY.account)]);
  assert.equal(query(cache, `SELECT company FROM account WHERE number = ${COMPANY.account}`)[0]!.company, COMPANY.name);
  assert.deepEqual(query(cache, `SELECT uuid, permissions FROM account_user WHERE account = ${SHARED.account} ORDER BY uuid`),
    [{ uuid: uuidText(PLAYERS.Tavrik.n), permissions: 7n }, { uuid: uuidText(PLAYERS.Quenby.n), permissions: 3n }]);
  assert.equal(query(cache, `SELECT owner FROM account WHERE number = ${PLAYERS.Tavrik.account}`)[0]!.owner, uuidText(PLAYERS.Tavrik.n));
  assert.deepEqual(query(cache, 'SELECT number FROM account WHERE frozen = 1').map((a) => a.number), [31n]);
  assert.equal(query(cache, 'SELECT count(*) AS n FROM market')[0]!.n, 8n);
});

test('chunk files are read in number order, so chunk_10 comes last', () => {
  const dir = path.join(fx.master, 'data/BankSystem/Bank_data/bankAccounts');
  assert.ok(fs.existsSync(path.join(dir, 'chunk_10.nbt')));
  assert.deepEqual(readChunks(dir).filter(isCompound).map((a) => num(a, 'accountNumber')), ACCOUNT_ORDER);
});

test('player UUIDs: the order table keeps them as lower-case text that joins with players and the ledger', () => {
  const { cache } = load(fx.master);
  const players = query(cache, 'SELECT DISTINCT player FROM orders').map((r) => r.player as string);
  assert.ok(players.every((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p)));
  assert.ok(players.includes(uuidText(PLAYERS.Tavrik.n)));
  assert.equal(query(cache, 'SELECT count(*) AS n FROM orders o JOIN player p ON p.uuid = o.player')[0]!.n, 86n);
  // Every finished order has its trade row in the ledger, written by the same player.
  assert.equal(query(cache, "SELECT count(*) AS n FROM orders o JOIN ledger l ON l.ref = 'sm:order:' || o.order_id AND l.actor = o.player")[0]!.n, 86n);
});

test("names the mods' files lack come from the server's usercache.json, for players that traded or acted only", () => {
  const server = path.join(fx.root, 'named-server'), world = path.join(server, 'world');
  fs.cpSync(fx.master, world, { recursive: true });
  for (const users of ['BankSystem/Bank_data/users', 'StockMarket/MarketManager/users']) fs.rmSync(path.join(world, 'data', users), { recursive: true });
  const nobody = '00000000-0000-4000-8000-0000000000ff';
  fs.writeFileSync(path.join(server, 'usercache.json'), JSON.stringify([
    { name: 'Tavrik', uuid: uuidText(PLAYERS.Tavrik.n).toUpperCase(), expiresOn: '2026-12-01 10:00:00 +0000' },
    { name: 'Nobody', uuid: nobody }, // never traded or acted: not a player of this case
    { name: '<script>', uuid: uuidText(PLAYERS.Quenby.n) }, // not a Minecraft name: skipped
    'junk',
  ]));
  const { cache } = load(world);
  assert.deepEqual(query(cache, 'SELECT uuid, name FROM player'), [{ uuid: uuidText(PLAYERS.Tavrik.n), name: 'Tavrik' }]);
});

test('importing leaves every file of a save untouched and adds none', () => {
  const before = [fx.master, fx.legacy, fx.slaves[1]!].map(listing);
  load(fx.master);
  load(fx.legacy);
  load(fx.slaves[1]!);
  assert.deepEqual([fx.master, fx.legacy, fx.slaves[1]!].map(listing), before);
});

test('a damaged market database gives up what is readable and says what was lost', () => {
  const dir = path.join(fx.root, 'damaged');
  fs.cpSync(fx.master, dir, { recursive: true });
  const file = path.join(dir, 'data/StockMarket/Database/stockdata.db');
  const probe = new DatabaseSync(file, { readOnly: true });
  assert.equal((probe.prepare('PRAGMA page_size').get() as { page_size: number }).page_size, 4096);
  const leaves = (probe.prepare("SELECT pageno FROM dbstat WHERE name = 'MarketPrice' AND pagetype = 'leaf' ORDER BY pageno").all() as { pageno: number }[]).map((r) => r.pageno);
  probe.close();
  const junk = leaves.slice(2, 5); // three candle pages in the middle; page 1 and the table's root stay intact
  assert.equal(junk.length, 3);
  assert.ok(!junk.includes(1));
  const fd = fs.openSync(file, 'r+');
  for (const page of junk) fs.writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, (page - 1) * 4096);
  fs.closeSync(fd);

  const { save } = load(dir);
  assert.deepEqual(status(save), ['bank:read', 'market:damaged', 'bankDiag:read', 'marketDiag:read', 'audit:read']);
  const candles = tables(save, 'market').find((t) => t.name === 'MarketPrice')!;
  assert.ok(candles.rows > fx.rows.master!.MarketPrice! / 2, `kept ${candles.rows} candles`);
  assert.ok(candles.lostIds > 0);
  assert.ok(candles.rows + candles.lostIds >= fx.rows.master!.MarketPrice!); // nothing vanishes without being counted
  assert.equal(tables(save, 'market').find((t) => t.name === 'OrderHistory')!.rows, 86);
  assert.equal(save.warnings.length, 1);
  assert.match(save.warnings[0]!, /could not be read/);
});

/** A copy of the master whose market database was changed by `change` first. */
function marketCopy(name: string, change: (file: string) => void) {
  const dir = path.join(fx.root, name);
  fs.cpSync(fx.master, dir, { recursive: true });
  change(path.join(dir, 'data/StockMarket/Database/stockdata.db'));
  return load(dir).save;
}

test("money is the market's currency from StockMarket's settings.json; banknotes stay BankSystem money", () => {
  const flags = (cache: string) => query(cache, 'SELECT id, money, bank FROM item WHERE id IN (1, 2) ORDER BY id').map((r) => [r.id, r.money, r.bank].map(Number));
  const plain = load(fx.master);
  assert.equal(plain.save.currency, '$'); // no settings.json: BankSystem money
  assert.deepEqual(flags(plain.cache), [[ITEM.money, 1, 1], [ITEM.diamond, 0, 0]]);
  const dir = path.join(fx.root, 'diamond-currency');
  fs.cpSync(fx.master, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data/StockMarket/settings.json'), JSON.stringify({ ServerMarket: { CURRENCY: { id: 'minecraft:diamond', count: 1 } } }));
  const diamond = load(dir);
  assert.equal(diamond.save.currency, 'Diamond');
  assert.deepEqual(flags(diamond.cache), [[ITEM.money, 0, 1], [ITEM.diamond, 1, 0]]);
});

test('rows past the id that sqlite_sequence recorded are copied too', () => {
  const save = marketCopy('stale-sequence', (file) => {
    const db = new DatabaseSync(file);
    db.exec("UPDATE sqlite_sequence SET seq = seq - 10 WHERE name IN ('MarketPrice', 'OrderHistory')");
    db.close();
  });
  assert.deepEqual(status(save), ['bank:read', 'market:read', 'bankDiag:read', 'marketDiag:read', 'audit:read']);
  assert.deepEqual(rowsOf(save, 'market'), { MarketPrice: 8 * 160, OrderHistory: 86 });
});

test('a damaged newest end is reported, even though nothing says how many rows it held', () => {
  const save = marketCopy('damaged-end', (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const last = (db.prepare("SELECT max(pageno) AS p FROM dbstat WHERE name = 'MarketPrice' AND pagetype = 'leaf'").get() as { p: number }).p;
    db.close();
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, (last - 1) * 4096);
    fs.closeSync(fd);
  });
  assert.equal(status(save)[1], 'market:damaged');
  const candles = tables(save, 'market').find((t) => t.name === 'MarketPrice')!;
  assert.equal(candles.newestLost, true);
  assert.ok(candles.rows > 0);
  assert.equal(tables(save, 'market').find((t) => t.name === 'OrderHistory')!.newestLost, false);
});

test('a market database cut in half (a copy that stopped early) gives up the rows it still holds', () => {
  const save = marketCopy('cut', (file) => fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2)));
  assert.equal(status(save)[1], 'market:damaged');
  const candles = tables(save, 'market').find((t) => t.name === 'MarketPrice')!;
  assert.ok(candles.rows > 0 && candles.lostIds > 0, `kept ${candles.rows}, lost ${candles.lostIds}`);
  assert.equal(candles.rows + candles.lostIds, fx.rows.master!.MarketPrice!);
  assert.match(save.warnings.join(' '), /could not be read/);
});

test('a file that is not a database is damaged, and a master without its market database says it is missing', () => {
  const dir = path.join(fx.root, 'broken');
  fs.cpSync(fx.master, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'data/StockMarket/Database/stockdata.db'));
  fs.writeFileSync(path.join(dir, 'data/BankSystem/Database/banksystem.db'), 'this is not a database');
  const { save } = load(dir);
  assert.deepEqual(status(save), ['bank:damaged', 'market:missing', 'bankDiag:read', 'marketDiag:read', 'audit:read']);
  assert.deepEqual(tables(save, 'bank'), []);
  assert.equal(save.players, 6); // the NBT files are still read
  // Without the bank's database nothing matches the audit log's entries: its times fall back to this computer's zone.
  assert.equal(save.warnings.length, 2);
  assert.match(save.warnings[0]!, /none of its entries could be matched.*this computer's time zone/);
  assert.equal(save.sources.find((s) => s.id === 'audit')!.note, 'times approximate (time zone unknown), 1 entry not readable (kept as text)');
});

test('a folder without mod data is refused in plain words', () => {
  const empty = path.join(fx.root, 'empty');
  fs.mkdirSync(empty);
  assert.throws(() => load(empty), /holds no BankSystem or StockMarket data/);
});

test('the engine reads SQLite and keeps 64-bit numbers exact', () => {
  const check = api.selfCheck();
  assert.match(check.sqlite, /^3\./);
  assert.equal(check.largest, 2n ** 63n - 1n);
});

/** A copy of the fixture's audit export whose manifest (or other files) a test may change. */
function exportCopy(name: string, change: (dir: string) => void) {
  const dir = path.join(fx.root, 'export-copies', name);
  fs.cpSync(fx.exported, dir, { recursive: true });
  change(dir);
  return dir;
}
const manifestOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
const writeManifest = (dir: string, json: unknown) => fs.writeFileSync(path.join(dir, 'manifest.json'), typeof json === 'string' ? json : JSON.stringify(json));

test('an audit export (BS-255) opens like a save: made when its manifest says, both mod versions, files the server lacked', () => {
  const { save } = load(fx.exported);
  assert.deepEqual([save.name, save.role, save.roleAssumed, save.serverUid, save.generation], [EXPORT.folder, 'MASTER', false, 'f0000000-0000-4000-8000-000000000001', 'current']);
  assert.equal(save.exported, true);
  assert.equal(save.lastPlayedMs, EXPORT.ms); // no level.dat in an export: the time it was made
  assert.equal(save.minecraft, MINECRAFT);
  assert.equal(save.bankVersion, '2.2.0'); // the bank's own files win over the manifest's 2.3.0
  assert.equal(save.marketVersion, EXPORT.market);
  assert.deepEqual(status(save), ['bank:read', 'market:read', 'bankDiag:read', 'marketDiag:read', 'audit:read']);
  assert.deepEqual(save.warnings, [`The server had no ${EXPORT.missing} when it made this export.`]); // not EXPORT.unread: the tool does not read it
  assert.equal(load(path.join(fx.exported, 'data')).save.exported, true); // its data folder picked directly
});

test('an export: the identity file wins over the manifest, and the manifest stands in when there is none', () => {
  const slave = exportCopy('role-differs', (dir) => writeManifest(dir, { ...manifestOf(dir), role: 'slave', server_uid: 'f0000000-0000-4000-8000-000000000009' }));
  assert.deepEqual([load(slave).save.role, load(slave).save.serverUid], ['MASTER', 'f0000000-0000-4000-8000-000000000001']);
  const bare = exportCopy('no-identity', (dir) => fs.rmSync(path.join(dir, 'data', 'ModUtilities', 'server_identity.json')));
  const { save } = load(bare);
  assert.deepEqual([save.role, save.roleAssumed, save.serverUid], ['MASTER', false, 'f0000000-0000-4000-8000-000000000001']);
});

test('an export: a size the manifest does not match is a warning, paths outside the export are ignored', () => {
  const dir = exportCopy('changed', (d) => {
    const m = manifestOf(d) as { participants: { stockmarket: { files: { path: string; size: number }[] }; banksystem: { files: unknown[]; error?: string } } };
    m.participants.stockmarket.files[0]!.size += 1;
    m.participants.banksystem.files.push({ path: '../../outside.db', method: 'file_copy', size: 1 }, { path: 'C:/outside.db', method: 'file_copy', size: 1 });
    m.participants.banksystem.error = 'disk full';
    writeManifest(d, m);
  });
  const { save } = load(dir);
  assert.equal(save.warnings.length, 3);
  assert.match(save.warnings[0]!, /^The export of banksystem reported a problem: disk full$/);
  assert.match(save.warnings[2]!, /^data\/StockMarket\/.+ is missing or not the size the export lists/);
});

test('an export with a broken, oversized or hostile manifest still opens, as a plain copy', () => {
  const plain = (dir: string) => { const { save } = load(dir); return [save.exported, save.role, save.lastPlayedMs, save.marketVersion]; };
  assert.deepEqual(plain(exportCopy('broken', (d) => writeManifest(d, '{"created_utc": '))), [false, 'MASTER', null, null]);
  assert.deepEqual(plain(exportCopy('huge', (d) => writeManifest(d, { ...manifestOf(d), pad: 'x'.repeat(1024 * 1024) }))), [false, 'MASTER', null, null]);
  assert.deepEqual(plain(exportCopy('array', (d) => writeManifest(d, [1, 2]))), [false, 'MASTER', null, null]);
  // Wrong types and keys that would reach the prototype are read as missing.
  const hostile = exportCopy('hostile', (d) => writeManifest(d, '{"created_utc": 5, "role": "__proto__", "mods": {"__proto__": {"stockmarket": "9"}, "banksystem": 3},'
    + ' "participants": {"__proto__": {"error": "x"}, "stockmarket": {"files": "all"}}, "server_uid": {"a": 1}}'));
  const { save } = load(hostile);
  assert.deepEqual([save.exported, save.lastPlayedMs, save.marketVersion, save.role, save.warnings], [true, null, null, 'MASTER', []]);
  assert.equal(({} as Record<string, unknown>).stockmarket, undefined);
});

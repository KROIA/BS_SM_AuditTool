// What the world holds: the stacks read from the player files of the main save and its loaded slaves at
// import (save/players.ts), and what the region scan found in blocks and entities (scan.ts). The other side of the banknote count.
import type { WorldItemsResult, WorldPlace, WorldPlayer, WorldStack } from '../../shared/api.ts';
import { at } from '../../shared/fmt.ts';
import { worthOf } from '../save/players.ts';
import { coverage, scanStatus } from '../scan.ts';
import { loadedSaves, mainData, mainSave, saveData } from '../workspace.ts';
import { marketItems, moneyItems } from './check.ts';
import { all, big, names, num, text } from './db.ts';
import { isSlaveOf } from './transfers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = '00000000-0000-0000-0000-000000000000';

const PLACES = 2_000;

const empty = (reason: string): WorldItemsResult => ({ reason, notes: 0n, inventory: 0n, enderChest: 0n, blocks: 0n, offers: 0n, places: [], placesCut: 0,
  scan: scanStatus(), players: [], altered: { stacks: 0, count: 0 }, missing: [], unnamed: 0, unreadable: [], files: 0, without: [] });

/** "minecraft:chest" -> "chest", "banksystem:money_stockpile_block_entity" -> "money stockpile", "minecraft:item" -> "dropped item" */
const placeName = (id: string) =>
  id === 'minecraft:item' ? 'dropped item' : id.slice(id.indexOf(':') + 1).replace(/_block_entity$|_entity$/, '').replaceAll('_', ' ') || 'block';

export function worldItems(): WorldItemsResult {
  const db = mainData(), main = mainSave();
  if (!db || !main) return empty('No save with bank data is loaded, so no player file can be compared with it.');
  const saves = [main, ...loadedSaves().filter(isSlaveOf(main))];
  const nameOf = names(db);
  const person = (uuid: string) => ({ uuid, name: nameOf(uuid) });
  // The main save's numbers: a slave's stacks have none of their own (a slave keeps no item list).
  const numberOf = new Map(all(db, 'SELECT name, min(id) AS id FROM item WHERE plain = 1 GROUP BY name').map((r) => [String(r.name), num(r.id)!]));
  const markets = marketItems(db);
  const money = moneyItems(db);

  const out = empty('');
  const read = new Set<string>(), bad = new Set<string>();
  const players = new Map<string, WorldPlayer>();
  for (const s of saves) {
    const sdb = saveData(s);
    const files = all(sdb, 'SELECT uuid, ok FROM player_file');
    if (!files.length) out.without.push(s.name);
    for (const f of files) (num(f.ok) ? read : bad).add(String(f.uuid));
    out.files += files.filter((f) => num(f.ok)).length;
    for (const r of all(sdb, 'SELECT player, place, path, item, item_id, count, plain, worth FROM world_item ORDER BY id')) {
      const item = String(r.item), count = num(r.count)!, worth = big(r.worth), plain = num(r.plain) === 1;
      if (!plain) {
        if (worthOf(item) !== null) { out.altered.stacks++; out.altered.count += count; }
        continue;
      }
      const itemId = num(r.item_id) ?? numberOf.get(item) ?? null;
      const value = worth === null ? null : BigInt(count) * worth;
      if (value === null && (itemId === null || !markets.has(itemId) || money.has(itemId))) continue;
      const uuid = String(r.player);
      const p = players.get(uuid) ?? players.set(uuid, { player: person(uuid), inventory: 0n, enderChest: 0n, notes: 0n, stacks: [], valuables: [] }).get(uuid)!;
      let path: string[] = [];
      try { const v: unknown = JSON.parse(text(r.path) ?? '[]'); if (Array.isArray(v)) path = v.map(String); } catch { /* written by the import; never fails */ }
      const stack: WorldStack = { server: s.name, place: r.place === 'ender chest' ? 'ender chest' : 'inventory', path, item, itemId, count, value };
      if (value === null) { p.valuables.push(stack); continue; }
      p.stacks.push(stack);
      p.notes += value;
      if (stack.place === 'inventory') p.inventory += value; else p.enderChest += value;
    }
  }
  // What the region scan found, in the files it read at their current size and time.
  const places = new Map<string, WorldPlace>();
  for (const s of saves) {
    const done = coverage(s).done;
    if (!done.size) continue;
    for (const r of all(saveData(s), 'SELECT * FROM scan_item ORDER BY id')) {
      if (!done.has(String(r.file))) continue;
      const item = String(r.item), count = num(r.count)!, worth = big(r.worth);
      if (num(r.plain) !== 1) {
        if (worthOf(item) !== null) { out.altered.stacks++; out.altered.count += count; }
        continue;
      }
      const itemId = numberOf.get(item) ?? null;
      const value = worth === null ? null : BigInt(count) * worth;
      if (value === null && (itemId === null || !markets.has(itemId) || money.has(itemId))) continue;
      const [dimension, x, y, z, place, source] = [String(r.dimension), num(r.x)!, num(r.y)!, num(r.z)!, String(r.place), String(r.source) as WorldPlace['source']];
      const owner = text(r.owner), account = num(r.account);
      const key = JSON.stringify([s.name, dimension, x, y, z, place, source, owner, account]);
      let p = places.get(key);
      if (!p) {
        const where = `${source === 'offer' ? `offers of a ${placeName(place)}` : placeName(place)} ${at(dimension, x, y, z)}`;
        places.set(key, (p = { server: s.name, dimension, x, y, z, place, source, where, player: owner ? person(owner) : null, account, notes: 0n, stacks: [], valuables: [] }));
      }
      let path: string[] = [];
      try { const v: unknown = JSON.parse(text(r.path) ?? '[]'); if (Array.isArray(v)) path = v.map(String); } catch { /* written by the scan; never fails */ }
      const stack = { path, item, itemId, count, value };
      if (value === null) { p.valuables.push(stack); continue; }
      p.stacks.push(stack);
      p.notes += value;
      if (source === 'offer') out.offers += value; else out.blocks += value;
    }
  }
  const pieces = (p: WorldPlace) => p.valuables.reduce((a, v) => a + v.count, 0);
  const sorted = [...places.values()].sort((a, b) => (b.notes > a.notes ? 1 : b.notes < a.notes ? -1 : pieces(b) - pieces(a)));
  out.places = sorted.slice(0, PLACES);
  out.placesCut = sorted.length - out.places.length;
  out.notes += out.blocks;

  if (!out.files && !bad.size && !out.scan.files) return { ...empty('None of the loaded saves has player files (the world\'s playerdata folder), so nothing could be counted.'), without: out.without };

  out.players = [...players.values()].sort((a, b) => (b.notes > a.notes ? 1 : b.notes < a.notes ? -1 : a.player.name.localeCompare(b.player.name)));
  for (const p of out.players) { out.notes += p.notes; out.inventory += p.inventory; out.enderChest += p.enderChest; }
  // Everyone who traded or used the bank should have a player file somewhere.
  const active = all(db, `SELECT player AS u FROM orders UNION SELECT actor FROM ledger WHERE actor IS NOT NULL
    UNION SELECT owner FROM account WHERE owner IS NOT NULL AND number IN (SELECT DISTINCT account FROM ledger)`).map((r) => String(r.u));
  // A UUID that neither the mods' files nor the usercache name never joined the server as a player (orders placed for it
  // on another player's account, for one); counted, not listed.
  const known = new Set(all(db, "SELECT uuid FROM player WHERE name <> ''").map((r) => String(r.uuid)));
  const without = [...new Set(active)].filter((u) => UUID.test(u) && u !== NIL && !read.has(u));
  out.unnamed = without.filter((u) => !known.has(u)).length;
  const missing = without.filter((u) => known.has(u)).map(person).sort((a, b) => a.name.localeCompare(b.name));
  out.missing = missing;
  out.unreadable = missing.filter((p) => bad.has(p.uuid));
  out.reason = null;
  return out;
}

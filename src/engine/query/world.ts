// What the players carry (DESIGN_SPEC 8.7): the stacks read from the player files of the main save and its loaded
// slaves at import (save/players.ts). The other side of the banknote count; the region scan (chests, other blocks) is AT-36.
import type { WorldItemsResult, WorldPlayer, WorldStack } from '../../shared/api.ts';
import { worthOf } from '../save/players.ts';
import { loadedSaves, mainData, mainSave, saveData } from '../workspace.ts';
import { moneyItems } from './check.ts';
import { all, big, names, num, text } from './db.ts';
import { isSlaveOf } from './transfers.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = '00000000-0000-0000-0000-000000000000';

const empty = (reason: string): WorldItemsResult =>
  ({ reason, notes: 0n, inventory: 0n, enderChest: 0n, players: [], altered: { stacks: 0, count: 0 }, missing: [], unnamed: 0, unreadable: [], files: 0, without: [] });

export function worldItems(): WorldItemsResult {
  const db = mainData(), main = mainSave();
  if (!db || !main) return empty('No save with bank data is loaded, so no player file can be compared with it.');
  const saves = [main, ...loadedSaves().filter(isSlaveOf(main))];
  const nameOf = names(db);
  const person = (uuid: string) => ({ uuid, name: nameOf(uuid) });
  // The main save's numbers: a slave's stacks have none of their own (a slave keeps no item list).
  const numberOf = new Map(all(db, 'SELECT name, min(id) AS id FROM item WHERE plain = 1 GROUP BY name').map((r) => [String(r.name), num(r.id)!]));
  const markets = new Set(all(db, 'SELECT item FROM market').map((r) => num(r.item)!));
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
  if (!out.files && !bad.size) return { ...empty('None of the loaded saves has player files (the world\'s playerdata folder), so nothing could be counted.'), without: out.without };

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

// The search field of the top bar: players, accounts, items and orders that match a few typed characters.
// Transfer ids are not searched yet: they have no screen before M4.
import type { SearchResult } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { all, names, num } from './db.ts';
import { readOrders } from './players.ts';

const MAX = 5;

export function search(text: string): SearchResult {
  const db = mainData();
  const q = text.trim().toLowerCase().slice(0, 100);
  const none: SearchResult = { players: [], accounts: [], items: [], orders: [] };
  if (!db || q.replace(/[%_\\ ]/g, '') === '') return none;
  // In LIKE, "_" stands for any one character: a space in "iron ingot" then also finds "iron_ingot".
  const like = '%' + q.replace(/[%\\]/g, '').replace(/ /g, '_') + '%', start = q.replace(/[%_\\]/g, '') + '%';
  const n = /^\d{1,15}$/.test(q) ? Number(q) : -1;

  const nameOf = names(db);
  const players = all(db, `SELECT uuid, lower(name) LIKE :start AS head FROM player WHERE lower(name) LIKE :like OR uuid LIKE :start
    UNION SELECT DISTINCT player, 0 FROM orders WHERE player LIKE :start AND player NOT IN (SELECT uuid FROM player)
    ORDER BY head DESC, uuid LIMIT ${MAX}`, { like, start }).map((r) => ({ uuid: String(r.uuid), name: nameOf(String(r.uuid)) }));
  const accounts = all(db, `SELECT number, name FROM account WHERE number = :n OR lower(name) LIKE :like
    ORDER BY number = :n DESC, number LIMIT ${MAX}`, { n, like }).map((r) => ({ number: num(r.number)!, name: String(r.name) }));
  const items = all(db, `SELECT id, name, money FROM item WHERE id = :n OR lower(name) LIKE :like
    ORDER BY id = :n DESC, length(name), id LIMIT ${MAX}`, { n, like }).map((r) => ({ id: num(r.id)!, name: String(r.name), money: r.money === 1n }));
  const id = /^(?:sm:order:)?(\d{1,15})$/.exec(q)?.[1];
  const orders = id === undefined ? [] : readOrders(db, { orderId: Number(id) }, null).slice(0, MAX).map((o) => ({ ...o, name: nameOf(o.player) }));
  return { players, accounts, items, orders };
}

// What the Bank accounts screen asks: the accounts, one account in detail, and one item's balance over time.
// The history comes from ledger() in players.ts. Bank data exists only on the master, so the server filter does not apply.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AccountDetail, AccountRow, Point, Scope } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { all, big, names, num, series, text } from './db.ts';

/** Accounts with their money now (from the bank's files) and their log entries in the scope, most money first. */
function read(db: DatabaseSync, scope: Scope, number?: number) {
  const params: Record<string, SQLInputValue> = {};
  if (scope.from !== null) params.from = scope.from;
  if (scope.to !== null) params.to = scope.to;
  if (number !== undefined) params.number = number;
  const nameOf = names(db);
  return all(db, `SELECT a.*,
      (SELECT coalesce(sum(b.balance + b.locked), 0) FROM balance b JOIN item i ON i.id = b.item AND i.money = 1 WHERE b.account = a.number) AS money,
      (SELECT count(*) FROM ledger l WHERE l.account = a.number ${scope.from !== null ? 'AND l.ts >= :from' : ''} ${scope.to !== null ? 'AND l.ts <= :to' : ''}) AS entries
    FROM account a ${number !== undefined ? 'WHERE a.number = :number' : ''} ORDER BY money DESC, a.number`, params).map((r) => {
    const owner = text(r.owner);
    return {
      number: num(r.number)!, name: String(r.name), company: text(r.company), frozen: r.frozen === 1n, owner, ownerName: owner && nameOf(owner),
      money: big(r.money)!, rows: num(r.entries)!, createdMs: num(r.created_ms),
    };
  });
}

export function accounts(scope: Scope): AccountRow[] {
  const db = mainData();
  if (!db) return [];
  return read(db, scope).map(({ createdMs: _c, ...row }) => row);
}

export function account(number: number, scope: Scope): AccountDetail | null {
  const db = mainData();
  const row = db && read(db, scope, number)[0];
  if (!db || !row) return null;
  const nameOf = names(db);
  return {
    ...row,
    users: all(db, 'SELECT uuid, permissions FROM account_user WHERE account = :number ORDER BY permissions DESC, uuid', { number })
      .map((u) => ({ uuid: String(u.uuid), name: nameOf(String(u.uuid)), permissions: num(u.permissions)! })),
    items: all(db, 'SELECT item, balance, locked FROM balance WHERE account = :number ORDER BY item', { number })
      .map((b) => ({ item: num(b.item)!, balance: big(b.balance)!, locked: big(b.locked)! })),
  };
}

export function balances(account: number, item: number, scope: Scope): Point[] {
  const db = mainData();
  if (!db) return [];
  const params: Record<string, SQLInputValue> = { account, item };
  if (scope.to !== null) params.to = scope.to;
  return series(all(db, `SELECT account, item, time, balance + locked AS v FROM snapshot WHERE account = :account AND item = :item
    ${scope.to !== null ? 'AND time <= :to' : ''} ORDER BY time, id`, params), scope);
}

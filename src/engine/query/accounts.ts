// What the Bank accounts screen asks: the accounts, one account in detail, and one item's balance over time.
// The history comes from ledger() in players.ts. Bank data exists only on the master; the server filter applies to its log rows
// where the log records the server (BS-256), not to balances and snapshots.
// An account deleted from the bank's files is still one when its snapshots or log rows remain.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { AccountDetail, AccountListRow, Point, Rating, RuleSettings, Scope } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { checkAll, moneyItems } from './check.ts';
import { all, big, names, num, series, text } from './db.ts';
import { onServer } from './players.ts';

/** Accounts with their money now (from the bank's files) and their log entries in the scope, most money first. */
function read(db: DatabaseSync, scope: Scope, number?: number) {
  const params: Record<string, SQLInputValue> = {};
  if (scope.from !== null) params.from = scope.from;
  if (scope.to !== null) params.to = scope.to;
  if (number !== undefined) params.number = number;
  const nameOf = names(db), server = onServer(scope, params, 'l.server');
  return all(db, `SELECT n.number, a.name, a.frozen, a.owner, a.company, a.created_ms, a.number IS NULL AS deleted,
      (SELECT coalesce(sum(b.balance + b.locked), 0) FROM balance b JOIN item i ON i.id = b.item AND i.money = 1 WHERE b.account = n.number) AS money,
      (SELECT count(*) FROM ledger l WHERE l.account = n.number ${scope.from !== null ? 'AND l.ts >= :from' : ''} ${scope.to !== null ? 'AND l.ts <= :to' : ''} ${server}) AS entries
    FROM (SELECT number FROM account UNION SELECT DISTINCT account FROM snapshot UNION SELECT DISTINCT account FROM ledger) n
    LEFT JOIN account a ON a.number = n.number ${number !== undefined ? 'WHERE n.number = :number' : ''} ORDER BY money DESC, n.number`, params).map((r) => {
    const owner = text(r.owner);
    return {
      number: num(r.number)!, name: text(r.name) ?? '', company: text(r.company), frozen: r.frozen === 1n, owner, ownerName: owner && nameOf(owner),
      money: big(r.money)!, rows: num(r.entries)!, deleted: r.deleted === 1n, createdMs: num(r.created_ms),
    };
  });
}

const RANK: Record<Rating, number> = { low: 0, medium: 1, high: 2 };

export function accounts(scope: Scope, settings: RuleSettings): AccountListRow[] {
  const db = mainData();
  if (!db) return [];
  const money = moneyItems(db), checked = checkAll(null, scope, settings);
  return read(db, scope)
    .map(({ createdMs: _c, ...row }): AccountListRow => {
      const gaps = (checked.get(row.number) ?? []).flatMap((c) => c.gaps.map((g) => ({ ...g, money: money.has(c.item) })));
      return {
        ...row, gaps: gaps.length,
        unexplained: gaps.reduce((s, g) => s + (!g.money ? 0n : g.difference < 0n ? -g.difference : g.difference), 0n),
        rating: gaps.reduce<Rating | null>((r, g) => (r === null || RANK[g.rating] > RANK[r] ? g.rating : r), null),
      };
    })
    .sort((a, b) => (a.unexplained !== b.unexplained ? (b.unexplained > a.unexplained ? 1 : -1) : b.gaps - a.gaps)); // stable: then most money
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

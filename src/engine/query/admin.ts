// Admin actions and changes from the bank's audit log (import: save/audit.ts). The log is the master's: no server filter.
import type { AdminEvent, Scope } from '../../shared/api.ts';
import { mainData } from '../workspace.ts';
import { all, big, num, text } from './db.ts';

export function adminEvents(scope: Scope): AdminEvent[] {
  const db = mainData();
  if (!db) return [];
  return all(db, `SELECT * FROM audit WHERE kind IN ('ADMIN', 'CHANGE') AND ts IS NOT NULL ${scope.from !== null ? 'AND ts >= :from' : ''} ${scope.to !== null ? 'AND ts <= :to' : ''} ORDER BY ts, id`,
    { ...(scope.from !== null ? { from: scope.from } : {}), ...(scope.to !== null ? { to: scope.to } : {}) }).map((r) => ({
    id: num(r.id)!, time: num(r.ts)!, approximate: r.approx === 1n, type: String(r.type), account: num(r.account), item: num(r.item), amount: r.kind === 'ADMIN' ? big(r.amount) : null,
    actor: String(r.actor), actorUuid: text(r.actor_uuid), player: text(r.player), note: r.kind === 'ADMIN' ? text(r.text) : null,
    subject: text(r.subject), state: text(r.state), ledgerId: r.kind === 'ADMIN' ? num(r.row_id) : null,
  }));
}

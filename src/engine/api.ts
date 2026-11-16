// The engine's answers. One function per question the screens ask; host.ts hands calls to this object.
import { DatabaseSync } from 'node:sqlite';
import type { EngineApi } from '../shared/api.ts';
import { account, accounts, balances } from './query/accounts.ts';
import { adminEvents } from './query/admin.ts';
import { banknotes } from './query/banknotes.ts';
import { check } from './query/check.ts';
import { findings } from './query/findings.ts';
import { moneyFlow } from './query/flow.ts';
import { incidents } from './query/incidents.ts';
import { candles, market, markets, traders } from './query/markets.ts';
import { links } from './query/links.ts';
import { keyEvents, overview } from './query/overview.ts';
import { items, ledger, orders, player, players } from './query/players.ts';
import { report } from './query/report.ts';
import { search } from './query/search.ts';
import { sessions } from './query/sessions.ts';
import { takeBack } from './query/takeback.ts';
import { flowTimeline } from './query/timeline.ts';
import { transfers } from './query/transfers.ts';
import { worldItems } from './query/world.ts';
import { scanStatus, startScan, stopScan } from './scan.ts';
import type { Scope } from '../shared/api.ts';
import { caseData, mark, open, reload, removeSave, setChoices, setRules, within, workspace } from './workspace.ts';

const answers: EngineApi = {
  workspace,
  addSave: open,
  reload,
  removeSave,
  caseData,
  mark,
  setRules,
  setChoices,
  items,
  players,
  player,
  orders,
  ledger,
  accounts,
  account,
  balances,
  markets,
  market,
  candles,
  traders,
  search,
  sessions,
  check,
  findings,
  incidents,
  adminEvents,
  overview,
  keyEvents,
  transfers,
  banknotes,
  links,
  moneyFlow,
  flowTimeline,
  takeBack,
  report,
  worldItems,
  startScan,
  stopScan,
  scanStatus,
  selfCheck() {
    const db = new DatabaseSync(':memory:');
    try {
      const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
      return { node: process.versions.node, sqlite: row.v, largest: 9223372036854775807n };
    } finally {
      db.close();
    }
  },
};

const isScope = (x: unknown): x is Scope => typeof x === 'object' && x !== null && 'from' in x && 'server' in x;
/** Every question runs under the focus of the scope it is given (none without one). */
export const api = Object.fromEntries(Object.entries(answers).map(([k, f]) =>
  [k, (...a: unknown[]) => within(a.find(isScope)?.focus, () => (f as (...a: unknown[]) => unknown)(...a))])) as unknown as EngineApi;

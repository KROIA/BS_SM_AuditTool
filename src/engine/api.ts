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
import { transfers } from './query/transfers.ts';
import { worldItems } from './query/world.ts';
import { scanStatus, startScan, stopScan } from './scan.ts';
import { addSave, caseData, mark, removeSave, setChoices, setRules, workspace } from './workspace.ts';

export const api: EngineApi = {
  workspace,
  addSave,
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

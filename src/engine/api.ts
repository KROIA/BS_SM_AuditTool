// The engine's answers. One function per question the screens ask; host.ts hands calls to this object.
import { DatabaseSync } from 'node:sqlite';
import type { EngineApi } from '../shared/api.ts';
import { addSave, removeSave, workspace } from './workspace.ts';

export const api: EngineApi = {
  workspace,
  addSave,
  removeSave,
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

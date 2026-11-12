// What the screens may ask the engine. The screens have no other way to reach a file.
// Everything here crosses the border between two processes, so it is plain data: no classes, no functions.

/** One table of a database: rows that were read, ids that could not be, and the time span the rows cover. */
export interface SaveTable {
  name: string;
  rows: number;
  lostIds: number;
  /** The rows written last could not be read (a copy taken while the mod was writing). How many is unknown. */
  newestLost: boolean;
  from: number | null;
  to: number | null;
}

/**
 * One data source of a save.
 * read: found and readable. damaged: found, but a part could not be read.
 * missing: should be there for this kind of save and is not. none: not there, and that is normal.
 */
export interface SaveSource {
  id: 'bank' | 'market' | 'bankDiag' | 'marketDiag';
  status: 'read' | 'damaged' | 'missing' | 'none';
  bytes: number;
  tables: SaveTable[];
}

export interface SaveSummary {
  /** The folder the user picked. */
  path: string;
  /** The slave's name, or the folder name. */
  name: string;
  role: 'MASTER' | 'SLAVE' | 'STANDALONE';
  /** True when there is no identity file and the role was worked out from the files found. */
  roleAssumed: boolean;
  serverUid: string | null;
  /** For a slave: the id of the master it belongs to. */
  masterUid: string | null;
  /** legacy: mod version 2.1.2, before the audit additions. */
  generation: 'legacy' | 'current';
  /** When the world was last played (level.dat), which is when the copy was taken at the latest. */
  lastPlayedMs: number | null;
  minecraft: string | null;
  /** The BankSystem version that wrote the save, when its files say so. */
  bankVersion: string | null;
  /** How many players and bank accounts the save's files list. */
  players: number;
  accounts: number;
  sources: SaveSource[];
  warnings: string[];
}

/** The loaded saves of one network, and what is odd about how they fit together. */
export interface Workspace {
  saves: SaveSummary[];
  warnings: string[];
}

/** Sent while a save is being read. */
export interface Progress {
  save: string;
  step: string;
  done: number;
  total: number;
}

/**
 * What every question about the data is limited to (DESIGN_SPEC section 5): the time range and the server filter
 * of the top bar. Times are epoch ms; null leaves that end open. server is a save's name; null means all servers.
 */
export interface Scope {
  from: number | null;
  to: number | null;
  server: string | null;
}

export interface EngineCheck {
  node: string;
  sqlite: string;
  /** 2^63 - 1, sent through every border to prove that 64-bit numbers arrive intact. */
  largest: bigint;
}

export interface EngineApi {
  /** The saves of the last session, read again only where they changed on disk. */
  workspace(): Workspace;
  addSave(path: string): Workspace;
  removeSave(path: string): Workspace;
  selfCheck(): EngineCheck;
}

/** The same calls as the screens see them: every answer arrives later. */
export type RemoteEngine = { [K in keyof EngineApi]: (...args: Parameters<EngineApi[K]>) => Promise<ReturnType<EngineApi[K]>> };

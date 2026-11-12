// What the screens may ask the engine. The screens have no other way to reach a file.
// Everything here crosses the border between two processes, so it is plain data: no classes, no functions.

/** One table of a database and how many rows it has; null when the table could not be read. */
export interface SaveTable {
  name: string;
  rows: number | null;
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
  /** legacy: mod version 2.1.2, before the audit additions. */
  generation: 'legacy' | 'current';
  sources: SaveSource[];
  warnings: string[];
}

export interface EngineCheck {
  node: string;
  sqlite: string;
  /** 2^63 - 1, sent through every border to prove that 64-bit numbers arrive intact. */
  largest: bigint;
}

export interface EngineApi {
  openSave(path: string): SaveSummary;
  selfCheck(): EngineCheck;
}

/** The same calls as the screens see them: every answer arrives later. */
export type RemoteEngine = { [K in keyof EngineApi]: (...args: Parameters<EngineApi[K]>) => Promise<ReturnType<EngineApi[K]>> };

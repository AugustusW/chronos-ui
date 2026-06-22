// SPDX-License-Identifier: Apache-2.0
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type ChronosDb = BetterSQLite3Database<typeof schema>

export interface DatabaseHandle {
  /** Drizzle query interface used by repositories. */
  db: ChronosDb
  /** Raw better-sqlite3 handle (pragmas, checkpoint, migrations). */
  sqlite: Database.Database
  /** Run a passive WAL checkpoint (call when the GUI opens / periodically). */
  checkpoint: () => void
  /** Close the underlying connection. */
  close: () => void
}

/**
 * Open a ChronosUI database. `path` is injected by the caller: Electron passes
 * `join(app.getPath('userData'), 'chronos.db')` (Plan 5); tests pass ':memory:' or a temp file.
 * Pragmas (WAL, busy_timeout, foreign_keys, journal_size_limit, synchronous) are configured here
 * for multi-process safety (the GUI and schedmgr both write). See spec §7.
 */
export function createDatabase(path: string): DatabaseHandle {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  // Bound WAL growth: many short-lived schedmgr writers rarely auto-checkpoint (spec §7).
  sqlite.pragma('journal_size_limit = 6291456') // 6 MiB
  const db = drizzle(sqlite, { schema })
  return {
    db,
    sqlite,
    checkpoint: () => {
      sqlite.pragma('wal_checkpoint(PASSIVE)')
    },
    close: () => sqlite.close()
  }
}

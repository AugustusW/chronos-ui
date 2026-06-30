// SPDX-License-Identifier: Apache-2.0
import Database from 'better-sqlite3'
import { Pool } from 'pg'
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as sqliteSchema from './schema'
import * as pgSchema from './schema.pg'

export type SqliteDb = BetterSQLite3Database<typeof sqliteSchema>
export type PgDb = NodePgDatabase<typeof pgSchema>
/** The canonical SQLite Drizzle handle — the synchronous repositories type against this. */
export type ChronosDb = SqliteDb
/** Either dialect's Drizzle handle — what `DatabaseHandle.db` actually holds at runtime.
 *  Consumers narrow it via the handle's `dialect` tag (the Repositories factory does this). */
export type AnyDb = SqliteDb | PgDb

export type BackendConfig =
  | { dialect: 'sqlite'; path: string }
  | { dialect: 'postgres'; dsn: string }

export interface DatabaseHandle {
  dialect: 'sqlite' | 'postgres'
  /** Drizzle query interface (dialect-specific concrete type narrowed by `dialect`). */
  db: AnyDb
  /** Raw better-sqlite3 handle — present only for sqlite (pragmas, checkpoint, migrations). */
  sqlite?: Database.Database
  /** node-postgres pool — present only for postgres. */
  pool?: Pool
  /** Passive WAL checkpoint (sqlite only; no-op for postgres). */
  checkpoint: () => void
  /** Close the underlying connection (async: pg pool.end()). */
  close: () => Promise<void>
}

function normalize(config: BackendConfig | string): BackendConfig {
  return typeof config === 'string' ? { dialect: 'sqlite', path: config } : config
}

/**
 * Decide the pg Pool TLS options for a DSN (review #11): if the DSN already specifies `sslmode`,
 * defer to it; otherwise a NON-local host must use TLS — a remote Postgres should never be reached in
 * cleartext (credentials + data would cross the network unencrypted) — while a local connection stays
 * plaintext. Exported for testing; node-postgres reads `ssl` from the Pool config.
 */
export function pgPoolOptions(dsn: string): { connectionString: string; ssl?: { rejectUnauthorized: boolean } } {
  let host = ''
  try {
    host = new URL(dsn).hostname
  } catch {
    /* not URL form (e.g. an unbracketed-IPv6 authority) → fall through to the key=value parse below */
  }
  // A libpq key=value DSN ("host=db.example.com dbname=app") doesn't URL-parse — pull host= out so a
  // remote key=value DSN still gets TLS (review #11 follow-up).
  if (host === '') {
    const m = dsn.match(/\bhost\s*=\s*(\S+)/i)
    if (m) host = m[1]
  }
  // sslmode in either URL-query (?sslmode=) or key=value (sslmode=) form → defer to the driver.
  const hasSslmode = /\bsslmode\s*=/i.test(dsn)
  // host === '' here means no host at all → a local Unix socket; treat as local.
  const isLocal = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (hasSslmode || isLocal) return { connectionString: dsn }
  return { connectionString: dsn, ssl: { rejectUnauthorized: true } }
}

/**
 * Open a ChronosUI database. SQLite is the default backend (zero-config; a path string or
 * `{ dialect: 'sqlite', path }`). PostgreSQL (`{ dialect: 'postgres', dsn }`) opens a `pg.Pool`.
 * SQLite pragmas (WAL, busy_timeout, foreign_keys, journal_size_limit, synchronous) are for
 * multi-process safety (the GUI and schedmgr both write). See spec §7 + the v1.1 PostgreSQL design.
 */
export function createDatabase(config: BackendConfig | string): DatabaseHandle {
  const cfg = normalize(config)
  if (cfg.dialect === 'postgres') {
    const pool = new Pool(pgPoolOptions(cfg.dsn))
    const db = drizzlePg(pool, { schema: pgSchema })
    return {
      dialect: 'postgres',
      db,
      pool,
      checkpoint: () => {},
      close: () => pool.end()
    }
  }
  const sqlite = new Database(cfg.path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  // Bound WAL growth: many short-lived schedmgr writers rarely auto-checkpoint (spec §7).
  sqlite.pragma('journal_size_limit = 6291456') // 6 MiB
  const db = drizzleSqlite(sqlite, { schema: sqliteSchema })
  return {
    dialect: 'sqlite',
    db,
    sqlite,
    checkpoint: () => {
      sqlite.pragma('wal_checkpoint(PASSIVE)')
    },
    close: () => {
      sqlite.close()
      return Promise.resolve()
    }
  }
}

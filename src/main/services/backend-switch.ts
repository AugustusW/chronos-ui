// SPDX-License-Identifier: Apache-2.0
//
// Bolt 2 (T5-T10): the backend-switch orchestration that flips ChronosUI from its default SQLite
// database to a user-supplied PostgreSQL instance (and back), reusing the PostgreSQL plumbing that
// already exists for day-2 operation (src/main/db/client.ts's createDatabase/pgPoolOptions,
// src/main/db/migrate.ts's runMigrations, the *.repository.pg.ts repos) rather than re-implementing
// any of it here. This module is Electron-free and every side effect (DB connections, keychain
// writes, native-scheduler edits, config-file writes) is dependency-injected, so it is fully
// unit-testable headlessly; the pg-touching pieces additionally get a real-Postgres integration
// suite (tests/services/backend-switch.pg.test.ts, gated on TEST_PG_URL like tests/db/repositories.test.ts).
//
// Every step here is best understood against the two orchestrations at the bottom of the file (once
// they land): switchToPostgres() (T8) and switchToSqlite() (T9). Both end by re-baking the schedmgr
// `--db` descriptor into every already-adopted cron/Task line (T10, rebakeDescriptors) and returning
// `{ ok: true, needRelaunch: true }` — the process itself does not hot-swap its open DB handle;
// bootstrap.ts's next launch reads the just-written backendConfig (see bootstrap.ts's "Plan 3
// switches GUI boot" comment — wiring the boot-time handle to the config is a later step, out of
// scope here).

import { Client } from 'pg'
import { pgPoolOptions } from '../db/client'
import { redactDsn } from './pg-dsn'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** redactDsn (pg-dsn.ts) is anchored at the START of a bare DSN string — exactly right for "log
 *  this DSN safely", but a driver/parser error can embed the DSN mid-sentence (e.g. "invalid
 *  connection string: postgresql://u:pw@host/db"), where the anchor never matches and the raw
 *  password would leak straight through `redactDsn(message)`. If the message contains the exact
 *  `dsn` we were given as a substring, swap that whole substring for its redacted form; otherwise
 *  fall through to redactDsn(message) (a no-op unless the message IS itself a bare DSN). Matching
 *  on the WHOLE dsn (not just the password fragment) deliberately avoids a shorter/common password
 *  value accidentally matching unrelated text elsewhere in the message (e.g. a password of "p"
 *  must not turn "password authentication failed" into "***assword authentication failed"). */
function redactError(err: unknown, dsn: string): string {
  const message = errMessage(err)
  if (message.includes(dsn)) return message.split(dsn).join(redactDsn(dsn))
  return redactDsn(message)
}

// ---------------------------------------------------------------------------------------------
// T5 — testConnection: a one-shot `SELECT version()` probe, used by the settings UI before
// committing to anything (migrate/copy/switch). Never leaves a connection open either way.
// ---------------------------------------------------------------------------------------------

/** Minimal structural slice of `pg.Client` this module depends on — real code gets it from
 *  `defaultClientFactory` (a real `pg.Client`); tests inject a fake so no test ever touches a
 *  real socket unless it explicitly opts into the TEST_PG_URL-gated integration suite. */
export interface PgClientLike {
  connect(): Promise<void>
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
}
export type PgClientFactory = (dsn: string) => PgClientLike

/** Real factory: a `pg.Client` configured via the same TLS-by-default-unless-local logic
 *  `createDatabase` uses for the long-lived pool (client.ts's pgPoolOptions) — a DSN typed into
 *  the settings UI gets the identical TLS decision whether it's a one-shot probe or the real pool. */
function defaultClientFactory(dsn: string): PgClientLike {
  return new Client(pgPoolOptions(dsn)) as unknown as PgClientLike
}

export type TestConnectionResult = { ok: true; version: string; ms: number } | { ok: false; error: string }

/** One-shot connect + `SELECT version()`. The error message is ALWAYS passed through redactDsn
 *  before it leaves this function — some `pg`/libpq failure paths (e.g. a malformed connection
 *  string) embed the raw DSN verbatim in the thrown error, and the caller (settings UI / Telegram
 *  reply) must never be able to leak the password via that path (spec: "密碼永不外洩"). */
export async function testConnection(
  dsn: string,
  clientFactory: PgClientFactory = defaultClientFactory
): Promise<TestConnectionResult> {
  const start = Date.now()
  try {
    const client = clientFactory(dsn)
    try {
      await client.connect()
      const res = await client.query('SELECT version()')
      const version = String((res.rows[0] as { version?: unknown } | undefined)?.version ?? '')
      return { ok: true, version, ms: Date.now() - start }
    } finally {
      // Best-effort: end() is attempted even after a failed connect()/query() so a probe never
      // leaks a socket. `client.end` itself is not expected to throw for our fake/real clients,
      // but never let a cleanup failure mask the real error from the try above.
      await client.end().catch(() => undefined)
    }
  } catch (err) {
    return { ok: false, error: redactError(err, dsn) }
  }
}

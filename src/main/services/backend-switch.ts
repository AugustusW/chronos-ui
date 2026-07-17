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
// Every step here is best understood against the two orchestrations at the bottom of the file:
// switchToPostgres() (T8) and switchToSqlite() (T9). Both end by re-baking the schedmgr `--db`
// descriptor into every already-adopted cron/Task line (T10, rebakeDescriptors) and returning
// `{ ok: true, needRelaunch: true }` — the process itself does not hot-swap its open DB handle;
// bootstrap.ts's next launch reads the just-written backendConfig (see bootstrap.ts's "Plan 3
// switches GUI boot" comment — wiring the boot-time handle to the config is a later step, out of
// scope here).

import { Client } from 'pg'
import { sql } from 'drizzle-orm'
import { createDatabase, pgPoolOptions, type DatabaseHandle, type SqliteDb, type PgDb } from '../db/client'
import { runMigrations } from '../db/migrate'
import { createRepositories } from '../db/repositories'
import * as sqliteSchema from '../db/schema'
import * as pgSchema from '../db/schema.pg'
import type { Job } from '../db/schema'
import { readBackendConfig, writeBackendConfig, type BackendConfigFile, type ConfigApp } from '../db/backendConfig'
import { schedmgrDbDescriptor } from '../scheduler/descriptor'
import type { SchedulerAdapter, WriteResult } from '../scheduler/types'
import { redactDsn } from './pg-dsn'
import { pgSecretStore, type PgSecretDeps } from './pg-secret'

/** Keychain service ChronosUI stores the active Postgres DSN under (mirrors the literal string
 *  already exercised by tests/bootstrap.test.ts + tests/scheduler/descriptor.test.ts). */
export const PG_DSN_SERVICE = 'com.augustusw.chronos-ui/pg-dsn'

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

// ---------------------------------------------------------------------------------------------
// T6 — migrateTarget: bring a fresh (or already-managed) target database's schema up to date by
// reusing the SAME pg migrator runMigrations() already applies at boot (src/main/db/migrate.ts) —
// no separate migration path for "the target of a backend switch" vs. "the app's own pg boot".
// assertTargetEmpty: refuse to copy into (or leave the app pointed at) a target that is NOT a
// fresh chronos database, so switchToPostgres never silently unions/duplicates data into an
// already-populated instance (e.g. the user fat-fingered a DSN that points at a database another
// ChronosUI install already uses).
// ---------------------------------------------------------------------------------------------

export type MigrateTargetResult = { ok: true } | { ok: false; error: string }

/** Apply pending pg migrations to `dsn` (opens + closes its own short-lived pool — this runs
 *  before the app commits to the target, so there is no long-lived handle to reuse yet). */
export async function migrateTarget(dsn: string, migrationsPgPath: string): Promise<MigrateTargetResult> {
  const handle = createDatabase({ dialect: 'postgres', dsn })
  try {
    // paths.sqlite is never read: runMigrations only touches it for a 'sqlite' handle (migrate.ts).
    await runMigrations(handle, { sqlite: '', pg: migrationsPgPath })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: redactError(err, dsn) }
  } finally {
    await handle.close()
  }
}

/** The 4 chronos tables (schema.pg.ts) — copyData's insert order (FK dependency order) doubles as
 *  the order assertTargetEmpty reports a non-empty table in. */
const CHRONOS_TABLES = ['jobs', 'run_logs', 'notify_settings', 'notify_outbox'] as const

/** Thrown by assertTargetEmpty when the target already carries rows in one or more chronos
 *  tables — switchToPostgres treats this as an abort-before-touching-anything error (never a
 *  cleanup case, since nothing was written yet at the point this throws). */
export class TargetNotEmptyError extends Error {
  constructor(public readonly nonEmptyTables: string[]) {
    super(`target Postgres database already has rows in: ${nonEmptyTables.join(', ')}`)
    this.name = 'TargetNotEmptyError'
  }
}

/** Postgres error code for "relation does not exist" (undefined_table) — raised when a chronos
 *  table hasn't been migrated into the target yet, which assertTargetEmpty treats as "empty"
 *  rather than an error (a target that's never been migrated is trivially empty). */
function isUndefinedTableError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '42P01'
}

/** Query each chronos table for at least one row; throw TargetNotEmptyError listing every table
 *  that has data. A table that doesn't exist yet counts as empty (isUndefinedTableError), so this
 *  is safe to call both before AND after migrateTarget. */
export async function assertTargetEmpty(dsn: string, clientFactory: PgClientFactory = defaultClientFactory): Promise<void> {
  const client = clientFactory(dsn)
  await client.connect()
  try {
    const nonEmpty: string[] = []
    for (const table of CHRONOS_TABLES) {
      try {
        const res = await client.query(`SELECT 1 FROM "${table}" LIMIT 1`)
        if (res.rows.length > 0) nonEmpty.push(table)
      } catch (err) {
        if (!isUndefinedTableError(err)) throw err
      }
    }
    if (nonEmpty.length > 0) throw new TargetNotEmptyError(nonEmpty)
  } finally {
    await client.end()
  }
}

/** Best-effort wipe of the 4 chronos tables (RESTART IDENTITY resets the serial sequences too, so
 *  a subsequent assertTargetEmpty + fresh copyData behaves exactly like a never-touched target).
 *  Used by switchToPostgres's cleanup-on-failure path to undo a partially-applied switch. */
export async function truncateTarget(dsn: string, clientFactory: PgClientFactory = defaultClientFactory): Promise<void> {
  const client = clientFactory(dsn)
  await client.connect()
  try {
    await client.query(`TRUNCATE ${CHRONOS_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)
  } finally {
    await client.end()
  }
}

// ---------------------------------------------------------------------------------------------
// T7 — copyData: one-time bulk copy of every row from the app's current SQLite database into the
// (already migrated + verified empty) Postgres target, inside a single transaction so a failure
// partway through never leaves a half-migrated target (switchToPostgres's cleanup-on-failure path
// truncates it back to empty either way, but the transaction means that path never has to reason
// about which of the 4 tables partially landed).
// ---------------------------------------------------------------------------------------------

export interface CopyDataCounts {
  jobs: number
  runLogs: number
  notifySettings: number
  notifyOutbox: number
}
export interface CopyDataResult {
  ok: true
  counts: CopyDataCounts
}

/** Thrown (inside the copy transaction, forcing a rollback) when a table's post-insert row count
 *  in the target doesn't match the source count read from SQLite — the copy is all-or-nothing. */
export class CopyCountMismatchError extends Error {
  constructor(
    public readonly table: string,
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`copyData: "${table}" count mismatch after insert — expected ${expected}, got ${actual}`)
    this.name = 'CopyCountMismatchError'
  }
}

/** PG's `text` type rejects a NUL byte outright (the row insert would throw); SQLite's `text`
 *  column has no such restriction, so captured stdout/stderr (schema.ts's run_logs.stdout/stderr,
 *  never length-validated beyond output.ts's keepLastBytes tail-truncation) can legally contain
 *  one if the job itself printed binary-ish output. Strip rather than reject: a lost NUL byte in
 *  historical log text is a cosmetic loss, not a data-integrity one. */
function stripNul(text: string): string {
  return text.replace(/\u0000/g, '')
}

export interface CopyDataDeps {
  /** Opens the target Postgres handle — injected (default: the real createDatabase) so a unit
   *  test can fault-inject a step (e.g. a transaction that throws) without a real server. */
  openPg: (dsn: string) => DatabaseHandle
}
const defaultCopyDataDeps: CopyDataDeps = {
  openPg: (dsn) => createDatabase({ dialect: 'postgres', dsn })
}

/** Copy jobs → run_logs → notify_settings → notify_outbox (FK dependency order) from `sqliteHandle`
 *  into `pgDsn`, preserving every row's original id and fixing up each table's serial sequence
 *  afterwards (`SELECT setval('<table>_id_seq', <max id>)`) so the app's next INSERT doesn't
 *  collide with a copied id. run_logs and notify_outbox are read directly off the Drizzle schema
 *  (sqliteSchema.runLogs / sqliteSchema.notifyOutbox) rather than through the RunLogsRepo — that
 *  repo's listRecent/listForJob default to `limit(50)`, which would silently drop history beyond
 *  the most recent 50 runs per job. jobs/notify_settings have no such limit either way but are
 *  read the same direct-schema way for consistency. */
export async function copyData(
  sqliteHandle: DatabaseHandle,
  pgDsn: string,
  deps: CopyDataDeps = defaultCopyDataDeps
): Promise<CopyDataResult> {
  const sqliteDb = sqliteHandle.db as SqliteDb
  const pgHandle = deps.openPg(pgDsn)
  try {
    const counts = await (pgHandle.db as PgDb).transaction(async (tx) => {
      // jobs
      const jobRows = await sqliteDb.select().from(sqliteSchema.jobs)
      if (jobRows.length > 0) {
        await tx.insert(pgSchema.jobs).values(jobRows as unknown as (typeof pgSchema.jobs.$inferInsert)[])
        await tx.execute(sql`SELECT setval('jobs_id_seq', ${Math.max(...jobRows.map((r) => r.id))})`)
      }
      const jobsInserted = (await tx.select().from(pgSchema.jobs)).length
      if (jobsInserted !== jobRows.length) throw new CopyCountMismatchError('jobs', jobRows.length, jobsInserted)

      // run_logs — full read (no repo-layer limit), NUL-strip stdout/stderr before insert.
      const runLogRows = await sqliteDb.select().from(sqliteSchema.runLogs)
      if (runLogRows.length > 0) {
        const sanitized = runLogRows.map((r) => ({
          ...r,
          stdout: r.stdout == null ? r.stdout : stripNul(r.stdout),
          stderr: r.stderr == null ? r.stderr : stripNul(r.stderr)
        }))
        await tx.insert(pgSchema.runLogs).values(sanitized as unknown as (typeof pgSchema.runLogs.$inferInsert)[])
        await tx.execute(sql`SELECT setval('run_logs_id_seq', ${Math.max(...runLogRows.map((r) => r.id))})`)
      }
      const runLogsInserted = (await tx.select().from(pgSchema.runLogs)).length
      if (runLogsInserted !== runLogRows.length) throw new CopyCountMismatchError('run_logs', runLogRows.length, runLogsInserted)

      // notify_settings — singleton row (id always 1, schema.ts: `integer('id').primaryKey()`), no
      // serial sequence to fix up.
      const notifySettingsRows = await sqliteDb.select().from(sqliteSchema.notifySettings)
      if (notifySettingsRows.length > 0) {
        await tx.insert(pgSchema.notifySettings).values(notifySettingsRows as unknown as (typeof pgSchema.notifySettings.$inferInsert)[])
      }
      const notifySettingsInserted = (await tx.select().from(pgSchema.notifySettings)).length
      if (notifySettingsInserted !== notifySettingsRows.length) {
        throw new CopyCountMismatchError('notify_settings', notifySettingsRows.length, notifySettingsInserted)
      }

      // notify_outbox — no TS repo layer at all (only the Go schedmgr reads/writes it); full read
      // straight off the schema, same as run_logs.
      const outboxRows = await sqliteDb.select().from(sqliteSchema.notifyOutbox)
      if (outboxRows.length > 0) {
        await tx.insert(pgSchema.notifyOutbox).values(outboxRows as unknown as (typeof pgSchema.notifyOutbox.$inferInsert)[])
        await tx.execute(sql`SELECT setval('notify_outbox_id_seq', ${Math.max(...outboxRows.map((r) => r.id))})`)
      }
      const outboxInserted = (await tx.select().from(pgSchema.notifyOutbox)).length
      if (outboxInserted !== outboxRows.length) throw new CopyCountMismatchError('notify_outbox', outboxRows.length, outboxInserted)

      return {
        jobs: jobRows.length,
        runLogs: runLogRows.length,
        notifySettings: notifySettingsRows.length,
        notifyOutbox: outboxRows.length
      }
    })
    return { ok: true, counts }
  } finally {
    await pgHandle.close()
  }
}

// ---------------------------------------------------------------------------------------------
// T10 — rebakeDescriptors: rewrite the schedmgr `--db` argument baked into every already-ADOPTED
// cron/Task line so it points at the new backend. A plain created-but-not-adopted job (jobs.service
// createJob) is never schedmgr-wrapped in the first place (no `--db` to rewrite), so only
// `adopted` jobs are touched. There is no adapter method to edit an adopted line's `--db` in
// place — updateJob() explicitly refuses to touch an adopted job's command (crontab.adapter.ts:
// "cannot change command of an adopted job; unadopt then adopt") — so this reuses the SAME
// unadopt-then-re-adopt recovery pattern jobs.service.ts's unadopt() already uses to keep the
// native line and the DB `adopted` flag in sync after a failed DB write. The DB `adopted` flag
// itself is never touched here: from the DB's perspective the job stays adopted throughout: only
// the native scheduler line's `--db` value changes.
// ---------------------------------------------------------------------------------------------

export interface RebakeDeps {
  /** Only the two adapter methods this needs — a plain object literal or a fake adapter satisfies
   *  this without needing to implement all of SchedulerAdapter. */
  adapter: Pick<SchedulerAdapter, 'unadopt' | 'adopt'>
  schedmgrPath: string
}

export interface RebakeResult {
  ok: boolean
  /** chronosIds successfully rewritten. */
  rebaked: number[]
  errors: Array<{ id: number; error: string }>
}

/** Re-bake every adopted job's `--db` to `schedmgrDbDescriptor(cfg, sqlitePath)` (descriptor.ts —
 *  `pg:keychain:<pgService>` for postgres, the plain file path for sqlite). Per-job failures are
 *  collected rather than aborting the whole batch (each cron line is independent); a job whose
 *  unadopt() fails is left as-is (still adopted, still on the OLD descriptor) and is NOT re-adopted
 *  (there is nothing to re-wrap — the native line was never unwrapped). `jobs` is caller-supplied
 *  (read from whichever DB handle is currently authoritative — always sqlite today; see the
 *  module-level comment on why the boot-time handle is always sqlite for now) rather than fetched
 *  here, keeping this function a pure orchestration over already-loaded data. */
export async function rebakeDescriptors(
  cfg: BackendConfigFile,
  sqlitePath: string,
  jobs: Pick<Job, 'id' | 'scheduleExpr' | 'command' | 'adopted'>[],
  deps: RebakeDeps
): Promise<RebakeResult> {
  const descriptor = schedmgrDbDescriptor(cfg, sqlitePath)
  const rebaked: number[] = []
  const errors: Array<{ id: number; error: string }> = []
  for (const j of jobs) {
    if (!j.adopted) continue
    const un = await deps.adapter.unadopt(j.id, j.command)
    if (!un.ok) {
      errors.push({ id: j.id, error: un.error ?? 'unadopt failed' })
      continue
    }
    const ad = await deps.adapter.adopt(j.id, {
      scheduleExpr: j.scheduleExpr,
      command: j.command,
      schedmgrPath: deps.schedmgrPath,
      dbPath: descriptor
    })
    if (!ad.ok) {
      errors.push({ id: j.id, error: ad.error ?? 'adopt failed' })
      continue
    }
    rebaked.push(j.id)
  }
  return { ok: errors.length === 0, rebaked, errors }
}

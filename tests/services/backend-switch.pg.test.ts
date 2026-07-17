// SPDX-License-Identifier: Apache-2.0
//
// Real-Postgres integration suite for backend-switch.ts (T5-T10). Gated on TEST_PG_URL exactly like
// tests/db/repositories.test.ts (CI's dedicated `test-pg` ubuntu job sets it; local runs can start a
// throwaway `docker run --rm -d -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16` and export
// TEST_PG_URL=postgres://postgres:test@localhost:55432/postgres).
//
// Isolation: repositories.test.ts's postgres backend runs its DDL/DML directly against TEST_PG_URL's
// own database (`postgres` in CI) and — being test-file-parallel under vitest — could interleave with
// anything else hitting that same database's `public`/`drizzle` schemas. Every test here instead
// bootstraps its OWN throwaway Postgres DATABASE (via a maintenance connection to TEST_PG_URL) per
// `describe` block and drops it afterwards, so this suite can never race repositories.test.ts (or a
// future pg-touching suite) regardless of vitest's file-level parallelism.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { join } from 'node:path'
import {
  testConnection,
  migrateTarget,
  assertTargetEmpty,
  TargetNotEmptyError,
  copyData,
  truncateTarget
} from '../../src/main/services/backend-switch'
import { createDatabase, type DatabaseHandle } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { createRepositories } from '../../src/main/db/repositories'

const PG_MIGRATIONS = join(__dirname, '../../src/main/db/migrations.pg')
const SQLITE_MIGRATIONS = join(__dirname, '../../src/main/db/migrations')

// A literal NUL byte, spelled as an escape (never embedded raw in this source file — a raw NUL in a
// .ts file trips up plain-text tooling like grep/diff, which treat the file as binary from that
// point on).
const NUL = '\u0000'

const maybeDescribe = process.env.TEST_PG_URL ? describe : describe.skip

/** Bootstraps (CREATE DATABASE) + tears down (DROP DATABASE) a throwaway Postgres database off the
 *  TEST_PG_URL maintenance connection, and returns a DSN pointed at it. */
async function withFreshDatabase<T>(name: string, fn: (dsn: string) => Promise<T>): Promise<T> {
  const base = new URL(process.env.TEST_PG_URL!)
  const admin = new Client({ connectionString: process.env.TEST_PG_URL })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const dsn = new URL(base.toString())
  dsn.pathname = `/${name}`
  try {
    return await fn(dsn.toString())
  } finally {
    const admin2 = new Client({ connectionString: process.env.TEST_PG_URL })
    await admin2.connect()
    try {
      // Terminate any lingering backends (a leaked pool/connection would make DROP DATABASE hang).
      await admin2.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      )
      await admin2.query(`DROP DATABASE IF EXISTS ${name}`)
    } finally {
      await admin2.end()
    }
  }
}

maybeDescribe('backend-switch.ts (real Postgres, TEST_PG_URL)', () => {
  describe('testConnection', () => {
    it('connects to a real database and returns a version string', async () => {
      await withFreshDatabase('chronos_bswitch_t5', async (dsn) => {
        const res = await testConnection(dsn)
        expect(res.ok).toBe(true)
        if (res.ok) {
          expect(res.version).toContain('PostgreSQL')
          expect(res.ms).toBeGreaterThanOrEqual(0)
        }
      })
    })

    it('returns ok:false with a redacted error for a database that does not exist', async () => {
      const base = new URL(process.env.TEST_PG_URL!)
      base.pathname = '/chronos_bswitch_does_not_exist'
      base.username = 'postgres'
      base.password = 'wrong-password-xyz'
      const res = await testConnection(base.toString())
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).not.toContain('wrong-password-xyz')
    })
  })

  describe('migrateTarget + assertTargetEmpty', () => {
    it('migrateTarget creates the chronos tables; assertTargetEmpty passes on the freshly migrated (empty) db', async () => {
      await withFreshDatabase('chronos_bswitch_t6_empty', async (dsn) => {
        const mig = await migrateTarget(dsn, PG_MIGRATIONS)
        expect(mig.ok).toBe(true)
        await expect(assertTargetEmpty(dsn)).resolves.toBeUndefined()
      })
    })

    it('assertTargetEmpty passes on a database where the tables do not exist yet (pre-migration)', async () => {
      await withFreshDatabase('chronos_bswitch_t6_nomigrate', async (dsn) => {
        await expect(assertTargetEmpty(dsn)).resolves.toBeUndefined()
      })
    })

    it('assertTargetEmpty throws TargetNotEmptyError when the target already has rows', async () => {
      await withFreshDatabase('chronos_bswitch_t6_dirty', async (dsn) => {
        await migrateTarget(dsn, PG_MIGRATIONS)
        const handle = createDatabase({ dialect: 'postgres', dsn })
        await createRepositories(handle).jobs.create({
          name: 'pre-existing',
          source: 'native_cron',
          platform: 'darwin',
          scheduleExpr: '* * * * *',
          command: 'echo hi',
          enabled: true,
          adopted: false
        })
        await handle.close()

        await expect(assertTargetEmpty(dsn)).rejects.toBeInstanceOf(TargetNotEmptyError)
        try {
          await assertTargetEmpty(dsn)
          expect.unreachable()
        } catch (err) {
          expect(err).toBeInstanceOf(TargetNotEmptyError)
          expect((err as InstanceType<typeof TargetNotEmptyError>).nonEmptyTables).toEqual(['jobs'])
        }
      })
    })
  })

  describe('copyData', () => {
    let sqliteHandle: DatabaseHandle

    beforeAll(async () => {
      sqliteHandle = createDatabase({ dialect: 'sqlite', path: ':memory:' })
      await runMigrations(sqliteHandle, { sqlite: SQLITE_MIGRATIONS, pg: PG_MIGRATIONS })
    })
    afterAll(async () => {
      await sqliteHandle.close()
    })

    it('copies jobs/run_logs/notify_settings/notify_outbox, preserves ids, strips NUL bytes, fixes up sequences (>50 run_logs)', async () => {
      const repos = createRepositories(sqliteHandle)
      const job = await repos.jobs.create({
        name: 'seed-job',
        source: 'native_cron',
        platform: 'darwin',
        scheduleExpr: '0 3 * * *',
        command: '/backup.sh',
        enabled: true,
        adopted: true
      })

      const RUN_COUNT = 62 // > the repo layer's default limit(50) — must NOT be silently truncated.
      let nulSampleId = -1
      for (let i = 0; i < RUN_COUNT; i++) {
        const run = await repos.runLogs.startRun({ jobId: job.id, triggeredBy: 'schedule' })
        const stdout = i === 5 ? `out${NUL}put with a NUL byte` : `stdout ${i}`
        await repos.runLogs.finishRun(run.id, { result: 'success', exitCode: 0, stdout, stderr: 'ok' })
        if (i === 5) nulSampleId = run.id
      }
      expect(nulSampleId).toBeGreaterThan(0)

      await repos.notifySettings.save({ enabled: true, chatId: '123', windowMin: 5, includeStderr: false })

      await withFreshDatabase('chronos_bswitch_t7_copy', async (dsn) => {
        const mig = await migrateTarget(dsn, PG_MIGRATIONS)
        expect(mig.ok).toBe(true)

        const result = await copyData(sqliteHandle, dsn)
        expect(result.ok).toBe(true)
        expect(result.counts).toEqual({ jobs: 1, runLogs: RUN_COUNT, notifySettings: 1, notifyOutbox: 0 })

        const target = createDatabase({ dialect: 'postgres', dsn })
        try {
          const targetRepos = createRepositories(target)
          // ids preserved
          expect((await targetRepos.jobs.get(job.id))?.name).toBe('seed-job')
          // full read, not capped at the repo default of 50
          const allRuns = await targetRepos.runLogs.listForJob(job.id, 1000)
          expect(allRuns.length).toBe(RUN_COUNT)
          // NUL stripped (PG text rejects it outright, so a non-throwing copy already proves this,
          // but assert the exact stripped content too)
          const nulRun = allRuns.find((r) => r.id === nulSampleId)
          expect(nulRun?.stdout).toBe('output with a NUL byte')
          expect(nulRun?.stdout).not.toContain(NUL)
          // sequence fixed up: the next insert must not collide with a copied id
          const extra = await targetRepos.runLogs.startRun({ jobId: job.id, triggeredBy: 'manual' })
          expect(extra.id).toBeGreaterThan(Math.max(...allRuns.map((r) => r.id)))
        } finally {
          await target.close()
        }
      })
    })

    it('rolls back the whole transaction (no partial copy) when a later insert fails', async () => {
      await withFreshDatabase('chronos_bswitch_t7_rollback', async (dsn) => {
        await migrateTarget(dsn, PG_MIGRATIONS)

        // Pre-seed the target with a jobs row that will collide (same id copyData tries to insert
        // for the source job) — a primary-key violation on the FIRST table copyData writes. Proves
        // the whole transaction (not just that one insert) rolls back.
        const target = createDatabase({ dialect: 'postgres', dsn })
        const targetRepos = createRepositories(target)
        await targetRepos.jobs.create({
          name: 'conflicting',
          source: 'native_cron',
          platform: 'darwin',
          scheduleExpr: '* * * * *',
          command: 'x',
          enabled: true,
          adopted: false
        })
        await target.close()

        await expect(copyData(sqliteHandle, dsn)).rejects.toThrow()

        // Rollback proof: only the ONE pre-seeded (pre-copy) row remains — nothing from the source
        // copy (which shares colliding jobs.id=1 with the pre-seed) committed.
        const verify = createDatabase({ dialect: 'postgres', dsn })
        try {
          const rows = await createRepositories(verify).jobs.list()
          expect(rows.map((r) => r.name)).toEqual(['conflicting'])
        } finally {
          await verify.close()
        }
      })
    })
  })

  describe('truncateTarget', () => {
    it('empties all 4 chronos tables and restarts identity so assertTargetEmpty passes again', async () => {
      await withFreshDatabase('chronos_bswitch_truncate', async (dsn) => {
        await migrateTarget(dsn, PG_MIGRATIONS)
        const handle = createDatabase({ dialect: 'postgres', dsn })
        const repos = createRepositories(handle)
        const job = await repos.jobs.create({
          name: 'to-be-truncated',
          source: 'native_cron',
          platform: 'darwin',
          scheduleExpr: '* * * * *',
          command: 'x',
          enabled: true,
          adopted: false
        })
        await repos.runLogs.startRun({ jobId: job.id, triggeredBy: 'manual' })
        await handle.close()

        await expect(assertTargetEmpty(dsn)).rejects.toBeInstanceOf(TargetNotEmptyError)
        await truncateTarget(dsn)
        await expect(assertTargetEmpty(dsn)).resolves.toBeUndefined()

        // identity restarted: a fresh insert lands back at id 1
        const verify = createDatabase({ dialect: 'postgres', dsn })
        try {
          const fresh = await createRepositories(verify).jobs.create({
            name: 'post-truncate',
            source: 'native_cron',
            platform: 'darwin',
            scheduleExpr: '* * * * *',
            command: 'x',
            enabled: true,
            adopted: false
          })
          expect(fresh.id).toBe(1)
        } finally {
          await verify.close()
        }
      })
    })
  })
})

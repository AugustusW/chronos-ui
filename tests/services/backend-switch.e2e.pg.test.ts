// SPDX-License-Identifier: Apache-2.0
//
// End-to-end "user switches backends" scenario (T19): a single full-chain test that drives
// switchToPostgres() over a realistic SQLite dataset (three jobs including two adopted, 60+
// run_logs with a NUL-byte stdout and a separate multi-byte-UTF-8 stdout, notify_settings, 2
// notify_outbox rows) against a REAL disposable Postgres database — every DB operation
// (testConnection/migrateTarget/assertTargetEmpty/copyData) is the real implementation; only the
// OS-touching side effects (keychain via pgSecretStore, and the native scheduler adapter) are
// spies, and the backendConfig file lives under a throwaway tmp dir. This complements (does not
// duplicate) backend-switch.pg.test.ts's granular per-step tests and its own T8 mid-fail/cleanup/
// retry coverage: this file exercises the full happy path once as a single coherent user scenario,
// asserts the documented step order (pgSecretStore -> config write -> rebakeDescriptors), and adds
// a post-switch write to prove the target is left genuinely usable afterward (not just correctly
// counted at the instant copyData finishes).
import { describe, it, expect, vi } from 'vitest'
import { Client } from 'pg'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { switchToPostgres, PG_DSN_SERVICE, type SwitchToPostgresDeps } from '../../src/main/services/backend-switch'
import { createDatabase, type SqliteDb } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'
import { createRepositories } from '../../src/main/db/repositories'
import { readBackendConfig } from '../../src/main/db/backendConfig'
import * as sqliteSchema from '../../src/main/db/schema'
import type { AdoptOptions, WriteResult } from '../../src/main/scheduler/types'

const PG_MIGRATIONS = join(__dirname, '../../src/main/db/migrations.pg')
const SQLITE_MIGRATIONS = join(__dirname, '../../src/main/db/migrations')

// A literal NUL byte, spelled as an escape (never embedded raw in this source file — see
// backend-switch.pg.test.ts's identical comment: a raw NUL trips up plain-text tooling).
const NUL = '\u0000'
// Multi-byte UTF-8 sample: CJK text + an emoji (the emoji is a surrogate pair in JS/UTF-16, i.e.
// more than one UTF-16 code unit) — deliberately mixed so a naive byte- or code-unit-based
// truncation elsewhere in the copy path would be caught too, not just plain ASCII round-tripping.
const UTF8_SAMPLE = '備份完成 ✅ 日本語もOK \u{1F389}'

const maybeDescribe = process.env.TEST_PG_URL ? describe : describe.skip

/** Bootstraps (CREATE DATABASE) + tears down (DROP DATABASE) a throwaway Postgres database off the
 *  TEST_PG_URL maintenance connection — identical convention to backend-switch.pg.test.ts /
 *  tests/db/repositories.test.ts (every pg-touching suite bootstraps its own DB so vitest's
 *  file-level parallelism can never race two suites against the same schema/database). */
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

maybeDescribe('backend-switch.ts end-to-end scenario (real Postgres, TEST_PG_URL)', () => {
  it('switches a realistic SQLite dataset to Postgres: full counts, NUL/UTF-8 integrity, id+sequence preservation, ordered spies, and a post-switch write', async () => {
    // ---- 1. Build a realistic SQLite source dataset -------------------------------------------
    const sqliteHandle = createDatabase({ dialect: 'sqlite', path: ':memory:' })
    await runMigrations(sqliteHandle, { sqlite: SQLITE_MIGRATIONS, pg: PG_MIGRATIONS })
    const repos = createRepositories(sqliteHandle)

    const adoptedJobA = await repos.jobs.create({
      name: 'nightly-backup',
      source: 'native_cron',
      platform: 'darwin',
      scheduleExpr: '0 3 * * *',
      command: '/backup.sh',
      enabled: true,
      adopted: true
    })
    const adoptedJobB = await repos.jobs.create({
      name: 'weekly-report',
      source: 'native_cron',
      platform: 'darwin',
      scheduleExpr: '0 9 * * 1',
      command: '/report.sh',
      enabled: true,
      adopted: true
    })
    const plainJob = await repos.jobs.create({
      name: 'ad-hoc',
      source: 'native_cron',
      platform: 'darwin',
      scheduleExpr: '*/30 * * * *',
      command: '/adhoc.sh',
      enabled: false,
      adopted: false
    })

    const RUN_COUNT = 63 // > the repo layer's default limit(50) — must NOT be silently truncated.
    let nulSampleId = -1
    let utf8SampleId = -1
    for (let i = 0; i < RUN_COUNT; i++) {
      const targetJob = i % 3 === 0 ? adoptedJobB : adoptedJobA
      const run = await repos.runLogs.startRun({ jobId: targetJob.id, triggeredBy: i % 5 === 0 ? 'manual' : 'schedule' })
      let stdout = `run ${i} ok`
      if (i === 7) {
        stdout = `pre${NUL}fix and ${NUL} more`
        nulSampleId = run.id
      }
      if (i === 19) {
        stdout = UTF8_SAMPLE
        utf8SampleId = run.id
      }
      await repos.runLogs.finishRun(run.id, { result: 'success', exitCode: 0, stdout, stderr: 'ok' })
    }
    expect(nulSampleId).toBeGreaterThan(0)
    expect(utf8SampleId).toBeGreaterThan(0)

    await repos.notifySettings.save({ enabled: true, chatId: '999888777', windowMin: 10, includeStderr: true })

    // notify_outbox has no TS repo layer at all (only the Go schedmgr reads/writes it — see
    // copyData's own comment) — insert straight off the Drizzle schema, same as copyData does when
    // reading it back out.
    const sqliteDb = sqliteHandle.db as SqliteDb
    await sqliteDb.insert(sqliteSchema.notifyOutbox).values([
      { jobId: adoptedJobA.id, jobName: adoptedJobA.name, result: 'failure', exitCode: 1, occurredAt: new Date() },
      { jobId: adoptedJobB.id, jobName: adoptedJobB.name, result: 'timeout', exitCode: null, occurredAt: new Date() }
    ])

    // ---- 2. switchToPostgres({copy:true}) — real DB ops, spied OS-touching side effects -------
    const configDir = mkdtempSync(join(tmpdir(), 'chronos-bswitch-e2e-'))
    const callOrder: string[] = []
    // configApp.getPath is exercised for real (writeBackendConfig/readBackendConfig both resolve
    // the config file through it) but wrapped in a spy so the "config write happened, and happened
    // between secretStore and rebake" step is asserted the same way as the other two side effects
    // rather than only inferred from the final file contents.
    const configApp = {
      getPath: vi.fn((): string => {
        callOrder.push('configWrite')
        return configDir
      })
    }
    const adoptCalls: Array<[number, AdoptOptions]> = []
    const adapter = {
      unadopt: vi.fn(async (id: number): Promise<WriteResult> => {
        callOrder.push(`unadopt:${id}`)
        return { ok: true }
      }),
      adopt: vi.fn(async (id: number, opts: AdoptOptions): Promise<WriteResult> => {
        callOrder.push(`adopt:${id}`)
        adoptCalls.push([id, opts])
        return { ok: true }
      })
    }
    const secretStoreSpy = vi.fn(async () => {
      callOrder.push('secretStore')
    })

    await withFreshDatabase('chronos_bswitch_e2e', async (dsn) => {
      const deps: SwitchToPostgresDeps = {
        sqliteHandle,
        migrationsPgPath: PG_MIGRATIONS,
        secretDeps: { exec: vi.fn(async () => ({ code: 1, stdout: '' })), platform: 'win32', configDir },
        configApp,
        sqlitePath: '/db/chronos.db',
        rebake: { adapter, schedmgrPath: '/opt/schedmgr' },
        pgSecretStore: secretStoreSpy
        // testConnection/migrateTarget/assertTargetEmpty/copyData/truncateTarget/rebakeDescriptors
        // all default to the real implementation — every DB operation in this test is real; only
        // the keychain write and the native-scheduler adapter are faked.
      }

      const result = await switchToPostgres({ dsn, copy: true }, deps)
      expect(result).toEqual({ ok: true, needRelaunch: true })

      // ---- 3. Assertions -----------------------------------------------------------------------
      // Snapshot the call order BEFORE any further assertion touches configApp.getPath again
      // (readBackendConfig below reuses the same spy) — this is the exact documented step order
      // from switchToPostgres's module comment: testConnection -> migrateTarget ->
      // assertTargetEmpty -> copyData -> pgSecretStore -> writeBackendConfig -> rebakeDescriptors.
      // Only the last 3 (the OS-touching ones) are spied here; jobs.list() (sqlite) returns
      // ascending-by-id order, so adoptedJobA (id 1) rebakes before adoptedJobB (id 2), and
      // plainJob (id 3, never adopted) is never touched.
      const orderSnapshot = [...callOrder]
      expect(orderSnapshot).toEqual([
        'secretStore',
        'configWrite',
        `unadopt:${adoptedJobA.id}`,
        `adopt:${adoptedJobA.id}`,
        `unadopt:${adoptedJobB.id}`,
        `adopt:${adoptedJobB.id}`
      ])

      expect(readBackendConfig(configApp)).toEqual({ backend: 'postgres', pgService: PG_DSN_SERVICE })
      expect(adoptCalls.every(([, opts]) => opts.dbPath === `pg:keychain:${PG_DSN_SERVICE}`)).toBe(true)

      const target = createDatabase({ dialect: 'postgres', dsn })
      try {
        const targetRepos = createRepositories(target)

        // 4-table counts match the source exactly: jobs=3, run_logs=63 (proves the repo layer's
        // listForJob/listRecent default limit(50) never silently truncated the copy — copyData
        // reads straight off the Drizzle schema, not through that capped repo method), notify_
        // settings=1, notify_outbox=2.
        expect((await targetRepos.jobs.list()).length).toBe(3)
        const allRunsA = await targetRepos.runLogs.listForJob(adoptedJobA.id, 1000)
        const allRunsB = await targetRepos.runLogs.listForJob(adoptedJobB.id, 1000)
        expect(allRunsA.length + allRunsB.length).toBe(RUN_COUNT)

        const pool = target.pool!
        const outboxCount = await pool.query('SELECT count(*)::int AS n FROM notify_outbox')
        expect(outboxCount.rows[0].n).toBe(2)
        const settingsRow = await pool.query('SELECT enabled, "chatId", "windowMin", "includeStderr" FROM notify_settings')
        expect(settingsRow.rows[0]).toMatchObject({ enabled: true, chatId: '999888777', windowMin: 10, includeStderr: true })

        // ids preserved (both an adopted and a never-adopted job).
        expect((await targetRepos.jobs.get(adoptedJobA.id))?.name).toBe('nightly-backup')
        expect((await targetRepos.jobs.get(plainJob.id))?.name).toBe('ad-hoc')

        // NUL stripped, multi-byte UTF-8 intact.
        const allRuns = [...allRunsA, ...allRunsB]
        const nulRun = allRuns.find((r) => r.id === nulSampleId)
        expect(nulRun?.stdout).toBe('prefix and  more')
        expect(nulRun?.stdout).not.toContain(NUL)
        const utf8Run = allRuns.find((r) => r.id === utf8SampleId)
        expect(utf8Run?.stdout).toBe(UTF8_SAMPLE)

        // sequences fixed up on BOTH touched tables: a fresh insert lands past every copied id.
        const maxRunId = Math.max(...allRuns.map((r) => r.id))
        const extraRun = await targetRepos.runLogs.startRun({ jobId: adoptedJobA.id, triggeredBy: 'manual' })
        expect(extraRun.id).toBeGreaterThan(maxRunId)
        const extraJob = await targetRepos.jobs.create({
          name: 'post-switch-job',
          source: 'native_cron',
          platform: 'darwin',
          scheduleExpr: '* * * * *',
          command: 'echo hi',
          enabled: true,
          adopted: false
        })
        expect(extraJob.id).toBeGreaterThan(plainJob.id)

        // ---- 4. Post-switch follow-up write -----------------------------------------------------
        // Bolt 2's switchToPostgres (T8, real steps except a fail-once pgSecretStore) describe block
        // already covers the mid-fail -> cleanup -> retry path; this instead proves the SUCCESSFUL
        // target keeps working for ordinary app traffic afterward, not just correctly counted at the
        // instant copyData committed.
        await targetRepos.runLogs.finishRun(extraRun.id, { result: 'success', exitCode: 0, stdout: 'post-switch write ok' })
        const verifyRun = await targetRepos.runLogs.getLatest(adoptedJobA.id)
        expect(verifyRun?.id).toBe(extraRun.id)
        expect(verifyRun?.stdout).toBe('post-switch write ok')
      } finally {
        await target.close()
      }
    })

    await sqliteHandle.close()
    rmSync(configDir, { recursive: true, force: true })
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { createDatabase, type DatabaseHandle } from '../../src/main/db/client'
import { createRepositories, type Repositories } from '../../src/main/db/repositories'

const SQLITE_MIGRATIONS = join(__dirname, '../../src/main/db/migrations')
const PG_MIGRATIONS = join(__dirname, '../../src/main/db/migrations.pg')

interface Backend {
  name: string
  open: () => Promise<DatabaseHandle>
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    open: async () => {
      const h = createDatabase({ dialect: 'sqlite', path: ':memory:' })
      migrateSqlite(h.db as never, { migrationsFolder: SQLITE_MIGRATIONS })
      return h
    }
  }
]

// Postgres backend only when TEST_PG_URL is set (CI / local docker). Each run starts from a clean schema.
if (process.env.TEST_PG_URL) {
  backends.push({
    name: 'postgres',
    open: async () => {
      const { migrate: migratePg } = await import('drizzle-orm/node-postgres/migrator')
      const h = createDatabase({ dialect: 'postgres', dsn: process.env.TEST_PG_URL! })
      // Full reset so every test re-migrates from scratch. node-postgres's migrator keeps its
      // journal in the `drizzle` schema (drizzle.__drizzle_migrations) — dropping only the tables
      // would leave the journal, making migratePg skip table creation on the 2nd+ test.
      // ALL tables must be dropped (not just jobs/run_logs): a persisting notify_settings would make
      // a re-applied ADD COLUMN migration (e.g. 0002 includeStderr) fail "column already exists".
      await h.pool!.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP TABLE IF EXISTS run_logs, notify_outbox, notify_settings, jobs CASCADE')
      await migratePg(h.db as never, { migrationsFolder: PG_MIGRATIONS })
      return h
    }
  })
}

const baseJob = {
  name: 'j',
  source: 'native_cron',
  platform: 'darwin',
  scheduleExpr: '* * * * *',
  command: 'echo hi',
  enabled: true,
  adopted: false
} as const

for (const backend of backends) {
  describe(`repositories [${backend.name}]`, () => {
    let handle: DatabaseHandle
    let repos: Repositories
    beforeEach(async () => {
      handle = await backend.open()
      repos = createRepositories(handle)
    })
    afterEach(async () => {
      await handle.close()
    })

    it('creates and reads back a job', async () => {
      const created = await repos.jobs.create({ ...baseJob })
      expect(created.id).toBeGreaterThan(0)
      const got = await repos.jobs.get(created.id)
      expect(got?.command).toBe('echo hi')
      expect(got?.enabled).toBe(true)
    })

    it('lists jobs in id order with filters', async () => {
      const a = await repos.jobs.create({ ...baseJob, category: 'x' })
      const b = await repos.jobs.create({ ...baseJob, category: 'y', enabled: false })
      const all = await repos.jobs.list()
      expect(all.map((j) => j.id)).toEqual([a.id, b.id])
      expect((await repos.jobs.list({ enabled: true })).map((j) => j.id)).toEqual([a.id])
      expect((await repos.jobs.list({ category: 'y' })).map((j) => j.id)).toEqual([b.id])
    })

    it('update bumps updatedAt; remove cascades run_logs', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      const before = (await repos.jobs.get(j.id))!.updatedAt.getTime()
      await new Promise((r) => setTimeout(r, 5))
      const upd = await repos.jobs.update(j.id, { name: 'renamed' })
      expect(upd?.name).toBe('renamed')
      expect(upd!.updatedAt.getTime()).toBeGreaterThanOrEqual(before)
      await repos.runLogs.startRun({ jobId: j.id, triggeredBy: 'manual' })
      await repos.jobs.remove(j.id)
      expect(await repos.jobs.get(j.id)).toBeUndefined()
      expect(await repos.runLogs.listForJob(j.id)).toEqual([])
    })

    it('startRun then finishRun records result, duration, truncation', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      const run = await repos.runLogs.startRun({
        jobId: j.id,
        triggeredBy: 'schedule',
        startedAt: new Date(Date.now() - 1000)
      })
      expect(run.result).toBeNull()
      const fin = await repos.runLogs.finishRun(run.id, { result: 'success', exitCode: 0, stdout: 'ok' })
      expect(fin?.result).toBe('success')
      expect(fin?.exitCode).toBe(0)
      expect(fin!.durationMs!).toBeGreaterThanOrEqual(1000)
      expect((await repos.runLogs.getLatest(j.id))?.id).toBe(run.id)
      expect((await repos.runLogs.listRecent()).length).toBe(1)
    })

    it('setCachedRun updates job cache without bumping updatedAt', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      const before = (await repos.jobs.get(j.id))!.updatedAt.getTime()
      await new Promise((r) => setTimeout(r, 5))
      await repos.jobs.setCachedRun(j.id, { lastRunAt: new Date(), lastResult: 'success' })
      const after = await repos.jobs.get(j.id)
      expect(after?.lastResult).toBe('success')
      expect(after!.updatedAt.getTime()).toBe(before) // cache update must NOT bump updatedAt
    })

    it('round-trips env json and exact millisecond timestamps across dialects', async () => {
      // env: sqlite text-json vs pg jsonb — both must reconstruct the same object.
      const j = await repos.jobs.create({ ...baseJob, env: { PATH: '/usr/bin', TZ: 'UTC' } })
      expect((await repos.jobs.get(j.id))?.env).toEqual({ PATH: '/usr/bin', TZ: 'UTC' })
      // timestamp: sqlite ms-int vs pg timestamptz — a ms-precision Date must survive exactly.
      const startedAt = new Date(Date.now() - 1234)
      const run = await repos.runLogs.startRun({ jobId: j.id, triggeredBy: 'schedule', startedAt })
      expect(run.startedAt.getTime()).toBe(startedAt.getTime())
      expect((await repos.runLogs.getLatest(j.id))!.startedAt.getTime()).toBe(startedAt.getTime())
    })
  })
}

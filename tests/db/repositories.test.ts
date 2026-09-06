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
      await h.pool!.query('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP TABLE IF EXISTS job_revisions, run_logs, notify_outbox, notify_settings, jobs CASCADE')
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

    // job_revisions through the SAME harness as everything else: the pg repository is a
    // hand-written mirror with `as JobRevision` casts on every return, so without running it
    // against a real Postgres the entire pg half of a dual-dialect feature is unexercised.
    it('records a revision and reads it back, json columns intact', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      const rec = await repos.jobRevisions.record({
        jobId: j.id, source: 'edit', changedFields: ['command', 'env'],
        before: { command: 'a', env: null }, after: { command: 'b', env: { TOKEN: 'x' } }
      })
      expect(rec.id).toBeGreaterThan(0)
      expect(rec.changedAt).toBeInstanceOf(Date)
      const [row] = await repos.jobRevisions.listForJob(j.id)
      expect(row.changedFields).toEqual(['command', 'env'])
      expect(row.before).toEqual({ command: 'a', env: null })
      expect(row.after).toEqual({ command: 'b', env: { TOKEN: 'x' } })
    })

    it('lists revisions newest first, honours the limit, and scopes to one job', async () => {
      const a = await repos.jobs.create({ ...baseJob })
      const b = await repos.jobs.create({ ...baseJob })
      for (let i = 0; i < 3; i++) {
        await repos.jobRevisions.record({
          jobId: a.id, source: 'edit', changedFields: ['command'],
          before: { command: `c${i}` }, after: { command: `c${i + 1}` },
          changedAt: new Date(1_700_000_000_000 + i * 1000)
        })
      }
      const rows = await repos.jobRevisions.listForJob(a.id, 2)
      expect(rows.map((r) => (r.after as { command: string }).command)).toEqual(['c3', 'c2'])
      expect(await repos.jobRevisions.listForJob(b.id)).toEqual([])
    })

    it('getLatest filters by source and returns undefined when there is none', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      await repos.jobRevisions.record({ jobId: j.id, source: 'external', changedFields: ['command'], before: { command: 'x' }, after: { command: 'y' }, changedAt: new Date(1000) })
      await repos.jobRevisions.record({ jobId: j.id, source: 'edit', changedFields: ['command'], before: { command: 'y' }, after: { command: 'z' }, changedAt: new Date(2000) })
      expect((await repos.jobRevisions.getLatest(j.id))?.source).toBe('edit')
      expect((await repos.jobRevisions.getLatest(j.id, 'external'))?.after).toEqual({ command: 'y' })
      expect(await repos.jobRevisions.getLatest(j.id, 'unadopt')).toBeUndefined()
    })

    it('getLatest accepts a set of sources — the query the drift logic runs through', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      await repos.jobRevisions.record({ jobId: j.id, source: 'external', changedFields: ['command'], before: { command: 'a' }, after: { command: 'b' }, changedAt: new Date(1000) })
      await repos.jobRevisions.record({ jobId: j.id, source: 'resolved', changedFields: ['command'], before: { command: 'b' }, after: { command: 'a' }, changedAt: new Date(2000) })
      await repos.jobRevisions.record({ jobId: j.id, source: 'edit', changedFields: ['name'], before: { name: 'x' }, after: { name: 'y' }, changedAt: new Date(3000) })

      // The newest of {external, resolved} — an unrelated newer `edit` must not be returned, or
      // "is this difference still standing?" gets the wrong answer.
      const latest = await repos.jobRevisions.getLatest(j.id, ['external', 'resolved'])
      expect(latest?.source).toBe('resolved')
      expect(await repos.jobRevisions.getLatest(j.id, ['adopt', 'unadopt'])).toBeUndefined()
    })

    it('removing a job cascades its revisions', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      await repos.jobRevisions.record({ jobId: j.id, source: 'edit', changedFields: ['name'], before: {}, after: {} })
      await repos.jobs.remove(j.id)
      expect(await repos.jobRevisions.listForJob(j.id)).toEqual([])
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

    it('pruneOlderThan removes runs before the cutoff and keeps newer ones (review #4)', async () => {
      const j = await repos.jobs.create({ ...baseJob })
      const DAY = 24 * 60 * 60 * 1000
      const old = await repos.runLogs.startRun({ jobId: j.id, triggeredBy: 'schedule', startedAt: new Date(Date.now() - 100 * DAY) })
      const recent = await repos.runLogs.startRun({ jobId: j.id, triggeredBy: 'schedule', startedAt: new Date(Date.now() - 1 * DAY) })
      const removed = await repos.runLogs.pruneOlderThan(new Date(Date.now() - 90 * DAY))
      expect(removed).toBe(1)
      const remaining = await repos.runLogs.listForJob(j.id)
      expect(remaining.map((r) => r.id)).toEqual([recent.id])
      expect(remaining.map((r) => r.id)).not.toContain(old.id)
    })

    // Final review #5/T4: dashboard.repository.test.ts (sqlite) already covers these functions
    // directly, but never through Repositories.dashboard — so the pg implementation
    // (dashboard.repository.pg.ts) had zero test coverage even under `TEST_PG_URL`. Running this
    // through the shared backend loop closes that gap for the pg lane (sqlite gets it too, as a
    // bonus — no harm, since it's the same fixture/interface both dialects share).
    it('dashboard repo: countsSince/listFailuresSince/countFailuresSince/countActiveJobs agree on a small fixture', async () => {
      const active = await repos.jobs.create({ ...baseJob, enabled: true, adopted: true })
      // Created only for its side effect — enabled-but-unadopted must not count as "active".
      await repos.jobs.create({ ...baseJob, enabled: true, adopted: false })
      const since = new Date(Date.now() - 60_000)

      const ok = await repos.runLogs.startRun({ jobId: active.id, triggeredBy: 'schedule', startedAt: new Date() })
      await repos.runLogs.finishRun(ok.id, { result: 'success', exitCode: 0 })
      const bad = await repos.runLogs.startRun({ jobId: active.id, triggeredBy: 'schedule', startedAt: new Date() })
      await repos.runLogs.finishRun(bad.id, { result: 'failure', exitCode: 1 })
      // In-progress run (result still NULL) must not count toward any aggregate.
      await repos.runLogs.startRun({ jobId: active.id, triggeredBy: 'schedule', startedAt: new Date() })

      expect(await repos.dashboard.countsSince(since)).toEqual({ runs: 2, succeeded: 1, failed: 1 })

      const failures = await repos.dashboard.listFailuresSince(since, 20)
      expect(failures.map((f) => f.jobId)).toEqual([active.id])
      expect(failures[0].result).toBe('failure')

      expect(await repos.dashboard.countFailuresSince(since)).toBe(1)
      // active job (enabled+adopted) counts; inactive (enabled but not adopted) does not.
      expect(await repos.dashboard.countActiveJobs()).toBe(1)
    })
  })
}

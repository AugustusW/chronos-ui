// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb } from './helpers'
import type { DatabaseHandle } from '../../src/main/db/client'
import { createJob } from '../../src/main/db/jobs.repository'
import {
  startRun,
  finishRun,
  listRunsForJob,
  listRecentRuns,
  getLatestRun,
  listRunDurationTrend,
  searchRuns,
  escapeLikeTerm
} from '../../src/main/db/runLogs.repository'
import { keepLastBytes } from '../../src/main/db/output'

let h: DatabaseHandle
let jobId: number

beforeEach(() => {
  h = makeTestDb()
  jobId = createJob(h.db, {
    name: 'job',
    source: 'native_cron',
    platform: 'darwin',
    scheduleExpr: '* * * * *',
    command: 'echo hi'
  }).id
})
afterEach(() => h.close())

describe('keepLastBytes', () => {
  it('passes short strings through unchanged', () => {
    expect(keepLastBytes('hello', 64 * 1024)).toBe('hello')
  })
  it('keeps the last N bytes of an oversized string', () => {
    const s = 'a'.repeat(100)
    expect(keepLastBytes(s, 10)).toBe('a'.repeat(10))
  })
  it('truncates on a UTF-8 boundary without exceeding maxBytes or emitting U+FFFD', () => {
    const s = '中'.repeat(30) // 90 bytes (3 bytes/char)
    const out = keepLastBytes(s, 10)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(10)
    expect(out).not.toContain('�')
    expect(out).toBe('中'.repeat(3)) // last 3 whole chars = 9 bytes
  })
})

describe('runLogs.repository', () => {
  it('starts a run as in-progress (null result, null endedAt)', () => {
    const run = startRun(h.db, { jobId, triggeredBy: 'manual' })
    expect(run.id).toBeGreaterThan(0)
    expect(run.result).toBeNull()
    expect(run.endedAt).toBeNull()
    expect(run.startedAt).toBeInstanceOf(Date)
  })

  it('finishes a run with result, duration, exit code, and truncated output', () => {
    const run = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    const finished = finishRun(h.db, run.id, {
      result: 'success',
      endedAt: new Date(run.startedAt.getTime() + 1200),
      exitCode: 0,
      stdout: 'x'.repeat(70 * 1024),
      stderr: 'err'
    })
    expect(finished?.result).toBe('success')
    expect(finished?.exitCode).toBe(0)
    expect(finished?.durationMs).toBe(1200)
    expect(Buffer.byteLength(finished!.stdout!, 'utf8')).toBe(64 * 1024)
    expect(finished?.stderr).toBe('err')
  })

  it('leaves stdout/stderr null when not provided (e.g. a timeout run)', () => {
    const run = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    const finished = finishRun(h.db, run.id, { result: 'timeout' })
    expect(finished?.result).toBe('timeout')
    expect(finished?.stdout).toBeNull()
    expect(finished?.stderr).toBeNull()
  })

  it('lists runs for a job newest-first and returns the latest', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'manual', startedAt: new Date(1000) })
    const r2 = startRun(h.db, { jobId, triggeredBy: 'manual', startedAt: new Date(2000) })
    const runs = listRunsForJob(h.db, jobId)
    expect(runs.map((r) => r.id)).toEqual([r2.id, r1.id])
    expect(getLatestRun(h.db, jobId)?.id).toBe(r2.id)
  })
})

describe('listRecentRuns', () => {
  it('returns runs across ≥2 jobs newest-first and respects limit', () => {
    // Create a second job
    const jobId2 = createJob(h.db, {
      name: 'job2',
      source: 'native_cron',
      platform: 'darwin',
      scheduleExpr: '0 * * * *',
      command: 'echo world'
    }).id

    // Seed runs: job1 older, job2 newer
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(1000) })
    const r2 = startRun(h.db, { jobId: jobId2, triggeredBy: 'manual', startedAt: new Date(3000) })
    const r3 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(2000) })

    // All three — newest-first across both jobs
    const all = listRecentRuns(h.db)
    expect(all.map((r) => r.id)).toEqual([r2.id, r3.id, r1.id])

    // Limit respected
    const top2 = listRecentRuns(h.db, 2)
    expect(top2.map((r) => r.id)).toEqual([r2.id, r3.id])
  })

  it('returns empty array when no runs exist', () => {
    expect(listRecentRuns(h.db)).toEqual([])
  })
})

// v0.4.0 — JobDetailView's duration-trend sparkline
describe('listRunDurationTrend', () => {
  it('returns only COMPLETED runs for the job, most-recent-first, capped at limit', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(1000) })
    finishRun(h.db, r1.id, { result: 'success', endedAt: new Date(1500) })
    const r2 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(2000) })
    finishRun(h.db, r2.id, { result: 'failure', endedAt: new Date(2300), exitCode: 1 })
    startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(3000) }) // still in-progress — excluded

    const trend = listRunDurationTrend(h.db, jobId, 10)
    expect(trend).toHaveLength(2)
    expect(trend.map((t) => t.result)).toEqual(['failure', 'success']) // most-recent-first
    expect(trend[1]).toMatchObject({ durationMs: 500, result: 'success' })

    expect(listRunDurationTrend(h.db, jobId, 1)).toHaveLength(1)
  })

  it("excludes another job's runs", () => {
    const jobId2 = createJob(h.db, { name: 'other', source: 'native_cron', platform: 'darwin', scheduleExpr: '* * * * *', command: 'x' }).id
    const r = startRun(h.db, { jobId: jobId2, triggeredBy: 'schedule' })
    finishRun(h.db, r.id, { result: 'success' })
    expect(listRunDurationTrend(h.db, jobId, 10)).toEqual([])
  })
})

// v0.4.0 — Run History search
describe('escapeLikeTerm', () => {
  it('escapes %, _ and the escape char itself', () => {
    expect(escapeLikeTerm('50%')).toBe('50\\%')
    expect(escapeLikeTerm('a_b')).toBe('a\\_b')
    expect(escapeLikeTerm('back\\slash')).toBe('back\\\\slash')
  })
  it('leaves an ordinary term untouched', () => {
    expect(escapeLikeTerm('backup failed')).toBe('backup failed')
  })
})

describe('searchRuns', () => {
  let jobId2: number
  beforeEach(() => {
    jobId2 = createJob(h.db, { name: 'Nightly Backup', source: 'native_cron', platform: 'darwin', scheduleExpr: '0 3 * * *', command: 'x' }).id
  })

  it('with no filters, returns everything newest-first, joined with jobName', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(1000) })
    finishRun(h.db, r1.id, { result: 'success' })
    const r2 = startRun(h.db, { jobId: jobId2, triggeredBy: 'schedule', startedAt: new Date(2000) })
    finishRun(h.db, r2.id, { result: 'failure', exitCode: 1 })

    const rows = searchRuns(h.db, { limit: 10 })
    expect(rows.map((r) => r.jobName)).toEqual(['Nightly Backup', 'job'])
  })

  it('filters by jobId', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r1.id, { result: 'success' })
    const r2 = startRun(h.db, { jobId: jobId2, triggeredBy: 'schedule' })
    finishRun(h.db, r2.id, { result: 'success' })
    expect(searchRuns(h.db, { jobId, limit: 10 }).map((r) => r.id)).toEqual([r1.id])
  })

  it('filters by result', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r1.id, { result: 'success' })
    const r2 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r2.id, { result: 'timeout' })
    expect(searchRuns(h.db, { result: 'timeout', limit: 10 }).map((r) => r.id)).toEqual([r2.id])
  })

  it('filters by since (inclusive)', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(1000) })
    finishRun(h.db, r1.id, { result: 'success' })
    const r2 = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(2000) })
    finishRun(h.db, r2.id, { result: 'success' })
    expect(searchRuns(h.db, { since: new Date(2000), limit: 10 }).map((r) => r.id)).toEqual([r2.id])
  })

  it('searchText matches job name, case-insensitively', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r1.id, { result: 'success' })
    const r2 = startRun(h.db, { jobId: jobId2, triggeredBy: 'schedule' })
    finishRun(h.db, r2.id, { result: 'success' })
    expect(searchRuns(h.db, { searchText: 'nightly', limit: 10 }).map((r) => r.id)).toEqual([r2.id])
  })

  it('searchText matches stdout/stderr content', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r1.id, { result: 'failure', stderr: 'connection refused on port 5432' })
    const r2 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r2.id, { result: 'success', stdout: 'all good' })
    expect(searchRuns(h.db, { searchText: 'refused', limit: 10 }).map((r) => r.id)).toEqual([r1.id])
  })

  it('a literal "%" in the search term matches literally, not as a wildcard (escapeLikeTerm)', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r1.id, { result: 'failure', stderr: 'disk 100% full' })
    const r2 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r2.id, { result: 'failure', stderr: 'disk XYZ full' }) // would ALSO match if % were a real wildcard
    expect(searchRuns(h.db, { searchText: '100%', limit: 10 }).map((r) => r.id)).toEqual([r1.id])
  })

  it('combines filters with AND', () => {
    const r1 = startRun(h.db, { jobId, triggeredBy: 'schedule' })
    finishRun(h.db, r1.id, { result: 'failure' })
    const r2 = startRun(h.db, { jobId: jobId2, triggeredBy: 'schedule' })
    finishRun(h.db, r2.id, { result: 'failure' })
    expect(searchRuns(h.db, { jobId, result: 'failure', limit: 10 }).map((r) => r.id)).toEqual([r1.id])
    expect(searchRuns(h.db, { jobId: jobId2, result: 'success', limit: 10 })).toEqual([])
  })

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      const r = startRun(h.db, { jobId, triggeredBy: 'schedule', startedAt: new Date(1000 + i) })
      finishRun(h.db, r.id, { result: 'success' })
    }
    expect(searchRuns(h.db, { limit: 2 })).toHaveLength(2)
  })
})

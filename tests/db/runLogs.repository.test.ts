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
  getLatestRun
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

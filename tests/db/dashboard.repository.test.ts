// SPDX-License-Identifier: Apache-2.0
// setup 仿 runLogs.repository.test.ts：makeTestDb() → 建 jobs/runs fixtures
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb } from './helpers'
import type { DatabaseHandle } from '../../src/main/db/client'
import { createJob } from '../../src/main/db/jobs.repository'
import { startRun, finishRun } from '../../src/main/db/runLogs.repository'
import {
  countsSince,
  listFailuresSince,
  countFailuresSince,
  countActiveJobs
} from '../../src/main/db/dashboard.repository'

const SINCE = new Date('2026-08-01T00:00:00')
const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000
/** Offset (ms) from SINCE — avoids re-parsing ISO strings across the SINCE boundary. */
const t = (offsetMs: number) => new Date(SINCE.getTime() + offsetMs)

let h: DatabaseHandle
let jobAId: number
let jobBId: number
let jobCId: number
let timeoutAt: Date

beforeEach(() => {
  h = makeTestDb()

  jobAId = createJob(h.db, {
    name: 'jobA',
    source: 'native_cron',
    platform: 'darwin',
    scheduleExpr: '* * * * *',
    command: 'echo a',
    enabled: true,
    adopted: true
  }).id
  jobBId = createJob(h.db, {
    name: 'jobB',
    source: 'native_cron',
    platform: 'darwin',
    scheduleExpr: '* * * * *',
    command: 'echo b',
    enabled: true,
    adopted: true
  }).id
  jobCId = createJob(h.db, {
    name: 'jobC',
    source: 'native_cron',
    platform: 'darwin',
    scheduleExpr: '* * * * *',
    command: 'echo c',
    enabled: false,
    adopted: true
  }).id

  // jobA (enabled, adopted): success@08:00, failure@09:00(exit 2), timeout@10:00
  const aSuccess = startRun(h.db, { jobId: jobAId, triggeredBy: 'schedule', startedAt: t(8 * HOUR) })
  finishRun(h.db, aSuccess.id, { result: 'success', endedAt: t(8 * HOUR + 5000), exitCode: 0 })

  const aFailure = startRun(h.db, { jobId: jobAId, triggeredBy: 'schedule', startedAt: t(9 * HOUR) })
  finishRun(h.db, aFailure.id, { result: 'failure', endedAt: t(9 * HOUR + 5000), exitCode: 2 })

  timeoutAt = t(10 * HOUR)
  const aTimeout = startRun(h.db, { jobId: jobAId, triggeredBy: 'schedule', startedAt: timeoutAt })
  finishRun(h.db, aTimeout.id, { result: 'timeout', endedAt: t(10 * HOUR + 5 * MIN) })

  // jobB (enabled, adopted): success 昨天23:50 (before SINCE, 不計), in-progress@10:10 (result NULL, 不計)
  const bBefore = startRun(h.db, { jobId: jobBId, triggeredBy: 'schedule', startedAt: t(-10 * MIN) })
  finishRun(h.db, bBefore.id, { result: 'success', endedAt: t(-9 * MIN), exitCode: 0 })

  startRun(h.db, { jobId: jobBId, triggeredBy: 'schedule', startedAt: t(10 * HOUR + 10 * MIN) })

  // jobC (disabled, adopted): failure@07:00 — 計入統計（run 發生過就算，即使 job 現在停用）
  const cFailure = startRun(h.db, { jobId: jobCId, triggeredBy: 'schedule', startedAt: t(7 * HOUR) })
  finishRun(h.db, cFailure.id, { result: 'failure', endedAt: t(7 * HOUR + 5000), exitCode: 1 })
})

afterEach(() => h.close())

describe('dashboard.repository (sqlite)', () => {
  it('countsSince: runs=4 succeeded=1 failed=3, NULL result 與 SINCE 前的都不計', () => {
    expect(countsSince(h.db, SINCE)).toEqual({ runs: 4, succeeded: 1, failed: 3 })
  })

  it('listFailuresSince: 依 startedAt DESC、帶 jobName join、limit 生效', () => {
    const failures = listFailuresSince(h.db, SINCE, 10)
    expect(failures).toHaveLength(3)
    expect(failures.map((f) => f.result)).toEqual(['timeout', 'failure', 'failure'])
    expect(failures[0]).toMatchObject({
      jobId: jobAId,
      jobName: 'jobA',
      result: 'timeout',
      exitCode: null
    })
    expect(failures[0].startedAt.getTime()).toBe(timeoutAt.getTime())
    expect(failures[1]).toMatchObject({ jobId: jobAId, jobName: 'jobA', result: 'failure', exitCode: 2 })
    expect(failures[2]).toMatchObject({ jobId: jobCId, jobName: 'jobC', result: 'failure', exitCode: 1 })

    // limit 生效
    const limited = listFailuresSince(h.db, SINCE, 2)
    expect(limited).toHaveLength(2)
    expect(limited.map((f) => f.result)).toEqual(['timeout', 'failure'])
  })

  it('countFailuresSince 回真實總數（> limit 時仍全計）', () => {
    expect(countFailuresSince(h.db, SINCE)).toBe(3)
    // 即使 listFailuresSince 用較小的 limit，countFailuresSince 不受影響、仍回真實總數
    expect(listFailuresSince(h.db, SINCE, 1)).toHaveLength(1)
    expect(countFailuresSince(h.db, SINCE)).toBe(3)
  })

  it('countActiveJobs 只算 enabled AND adopted', () => {
    // jobA/jobB enabled+adopted=2；jobC disabled 不計
    expect(countActiveJobs(h.db)).toBe(2)
  })
})

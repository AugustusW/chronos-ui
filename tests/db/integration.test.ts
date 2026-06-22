// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb } from './helpers'
import type { DatabaseHandle } from '../../src/main/db'
import {
  createJob,
  getJob,
  deleteJob,
  setJobCachedRun,
  startRun,
  finishRun,
  listRunsForJob
} from '../../src/main/db'

let h: DatabaseHandle

beforeEach(() => {
  h = makeTestDb()
})
afterEach(() => h.close())

describe('data layer integration', () => {
  it('runs a full job → run lifecycle and reflects it on the job cache', () => {
    const job = createJob(h.db, {
      name: 'backup',
      source: 'native_cron',
      platform: 'darwin',
      scheduleExpr: '0 3 * * *',
      command: 'backup.sh'
    })
    const run = startRun(h.db, { jobId: job.id, triggeredBy: 'manual' })
    const done = finishRun(h.db, run.id, { result: 'success', exitCode: 0, stdout: 'ok' })
    setJobCachedRun(h.db, job.id, { lastRunAt: done!.endedAt!, lastResult: done!.result! })

    const refreshed = getJob(h.db, job.id)
    expect(refreshed?.lastResult).toBe('success')
    expect(refreshed?.lastRunAt?.getTime()).toBe(done!.endedAt!.getTime())
    expect(listRunsForJob(h.db, job.id)).toHaveLength(1)
  })

  it('cascade-deletes run_logs when a job is deleted', () => {
    const job = createJob(h.db, {
      name: 'j',
      source: 'native_cron',
      platform: 'linux',
      scheduleExpr: '* * * * *',
      command: 'true'
    })
    startRun(h.db, { jobId: job.id, triggeredBy: 'schedule' })
    startRun(h.db, { jobId: job.id, triggeredBy: 'schedule' })
    expect(listRunsForJob(h.db, job.id)).toHaveLength(2)
    deleteJob(h.db, job.id)
    expect(listRunsForJob(h.db, job.id)).toHaveLength(0)
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../db/helpers'
import { createRepositories } from '../../src/main/db/repositories'
import { createJobsService } from '../../src/main/services/jobs.service'
import type { SchedulerAdapter, WriteResult, BatchWriteResult } from '../../src/main/scheduler/types'

function fakeAdapter(over: Partial<SchedulerAdapter> = {}): SchedulerAdapter {
  const ok = async (): Promise<WriteResult> => ({ ok: true })
  return {
    list: async () => [], createJob: ok, updateJob: ok, enableJob: ok, disableJob: ok,
    deleteJob: ok, adopt: ok, unadopt: ok, detectDrift: async () => ({ drifted: false, currentHash: '', expectedHash: '' }),
    adoptMany: async (_specs): Promise<BatchWriteResult> => ({ ok: true, adopted: _specs.map(s => s.chronosId) }),
    ...over
  }
}

function svc() {
  const h = makeTestDb()
  const repos = createRepositories(h)
  const service = createJobsService({ repos, adapter: fakeAdapter(), platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })
  return { h, service }
}

describe('jobs.service adopt category', () => {
  it('adopt persists category on the created job', async () => {
    const { h, service } = svc()
    const r = await service.adopt([{ name: 'x', scheduleExpr: '* * * * *', command: 'echo hi', category: 'backups' }])
    expect(r.ok).toBe(true)
    expect(r.adopted).toHaveLength(1)
    const id = r.adopted[0]
    // Verify the persisted job has the correct category
    const listed = await service.list()
    const item = listed.items.find(i => i.job?.id === id)
    expect(item?.job?.category).toBe('backups')
    h.close()
  })

  it('adopt without category stores null', async () => {
    const { h, service } = svc()
    const r = await service.adopt([{ name: 'y', scheduleExpr: '0 * * * *', command: 'echo bye' }])
    expect(r.ok).toBe(true)
    const id = r.adopted[0]
    const listed = await service.list()
    const item = listed.items.find(i => i.job?.id === id)
    expect(item?.job?.category).toBeNull()
    h.close()
  })
})

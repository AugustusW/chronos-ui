// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../db/helpers'
import { createRepositories } from '../../src/main/db/repositories'
import { createJobsService } from '../../src/main/services/jobs.service'
import type { SchedulerAdapter, WriteResult } from '../../src/main/scheduler/types'

function fakeAdapter(over: Partial<SchedulerAdapter> = {}): SchedulerAdapter {
  const ok = async (): Promise<WriteResult> => ({ ok: true })
  return {
    list: async () => [], createJob: ok, updateJob: ok, enableJob: ok, disableJob: ok,
    deleteJob: ok, adopt: ok, unadopt: ok, detectDrift: async () => ({ drifted: false, currentHash: '', expectedHash: '' }),
    adoptMany: async (specs) => ({ ok: true, adopted: specs.map(s => s.chronosId) }), ...over
  }
}

describe('jobs.service managedCount()', () => {
  it('returns 0 when there are no jobs in the DB', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const service = createJobsService({ repos, adapter: fakeAdapter(), platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    expect(await service.managedCount()).toBe(0)
    h.close()
  })

  it('returns 2 after creating 2 jobs', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const service = createJobsService({ repos, adapter: fakeAdapter(), platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    await service.create({ name: 'Alpha', scheduleExpr: '0 3 * * *', command: '/a.sh' })
    await service.create({ name: 'Beta', scheduleExpr: '0 4 * * *', command: '/b.sh' })

    expect(await service.managedCount()).toBe(2)
    h.close()
  })
})

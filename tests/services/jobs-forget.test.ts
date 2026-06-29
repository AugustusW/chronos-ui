// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
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

describe('jobs.service forget(id)', () => {
  it('removes a not-adopted job from the DB without calling the adapter', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const deleteJobSpy = vi.fn(async (): Promise<WriteResult> => ({ ok: true }))
    const unadoptSpy = vi.fn(async (): Promise<WriteResult> => ({ ok: true }))
    const adapter = fakeAdapter({ deleteJob: deleteJobSpy, unadopt: unadoptSpy })
    const service = createJobsService({ repos, adapter, platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    // Create a not-adopted job (create sets adopted:false by default)
    const created = await service.create({ name: 'j', scheduleExpr: '* * * * *', command: 'echo hi' })
    expect(created.ok).toBe(true)
    const id = created.job!.id

    const r = await service.forget(id)
    expect(r.ok).toBe(true)
    // DB row is gone
    expect(await repos.jobs.get(id)).toBeUndefined()
    // Adapter was NOT called
    expect(deleteJobSpy).not.toHaveBeenCalled()
    expect(unadoptSpy).not.toHaveBeenCalled()
    h.close()
  })

  it('rejects forgetting an adopted job and leaves the row intact', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const service = createJobsService({ repos, adapter: fakeAdapter(), platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    // Adopt a job (adopted=true)
    const r0 = await service.adopt([{ name: 'a', scheduleExpr: '0 * * * *', command: 'echo adopted' }])
    expect(r0.ok).toBe(true)
    const id = r0.adopted[0]

    const r = await service.forget(id)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/unadopt/)
    // Row still exists
    expect(await repos.jobs.get(id)).toBeDefined()
    h.close()
  })

  it('returns not_found for a missing id', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const service = createJobsService({ repos, adapter: fakeAdapter(), platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    const r = await service.forget(9999)
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('not_found')
    h.close()
  })
})

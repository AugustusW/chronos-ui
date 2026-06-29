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
    adoptMany: async () => ({ ok: true, adopted: [] }), ...over
  }
}

function svc() {
  const h = makeTestDb()
  const repos = createRepositories(h)
  const service = createJobsService({ repos, adapter: fakeAdapter(), platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })
  return { h, service }
}

describe('jobs.service notifyOnFailure', () => {
  it('update persists notifyOnFailure', async () => {
    const { h, service } = svc()
    const created = await service.create({ name: 'j', scheduleExpr: '* * * * *', command: 'echo hi' })
    expect(created.ok).toBe(true)
    const id = created.job!.id
    const r = await service.update(id, { notifyOnFailure: true })
    expect(r.ok).toBe(true)
    expect(r.job!.notifyOnFailure).toBe(true)
    h.close()
  })

  it('create defaults notifyOnFailure to false', async () => {
    const { h, service } = svc()
    const r = await service.create({ name: 'j2', scheduleExpr: '* * * * *', command: 'echo hi' })
    expect(r.ok).toBe(true)
    expect(r.job!.notifyOnFailure).toBe(false)
    h.close()
  })

  it('create with notifyOnFailure: true persists the flag', async () => {
    const { h, service } = svc()
    const r = await service.create({ name: 'j3', scheduleExpr: '* * * * *', command: 'echo hi', notifyOnFailure: true })
    expect(r.ok).toBe(true)
    expect(r.job!.notifyOnFailure).toBe(true)
    h.close()
  })
})

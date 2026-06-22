// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { openAndMigrate } from '../../src/main/db/lifecycle'
import { getJob, listJobs } from '../../src/main/db/jobs.repository'
import { createJobsService } from '../../src/main/services/jobs.service'
import type { SchedulerAdapter, WriteResult, ParsedJob } from '../../src/main/scheduler/types'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))

function fakeAdapter(over: Partial<SchedulerAdapter> = {}): SchedulerAdapter {
  const ok = async (): Promise<WriteResult> => ({ ok: true })
  return {
    list: async () => [], createJob: ok, updateJob: ok, enableJob: ok, disableJob: ok,
    deleteJob: ok, adopt: ok, unadopt: ok, detectDrift: async () => ({ drifted: false, currentHash: '', expectedHash: '' }),
    adoptMany: async () => ({ ok: true, adopted: [] }), ...over
  }
}

function svc(adapter: SchedulerAdapter) {
  const h = openAndMigrate(':memory:', MIGRATIONS)
  return { h, service: createJobsService({ db: h.db, adapter, platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' }) }
}

describe('jobs.service create', () => {
  it('inserts a DB row then writes the native line', async () => {
    const calls: string[] = []
    const { h, service } = svc(fakeAdapter({ createJob: async () => { calls.push('createJob'); return { ok: true } } }))
    const r = await service.create({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    expect(r.ok).toBe(true)
    expect(r.job?.id).toBeGreaterThan(0)
    expect(calls).toEqual(['createJob'])
    expect(listJobs(h.db)).toHaveLength(1)
    h.close()
  })

  it('rolls back the DB row when the adapter write fails (compensating action)', async () => {
    const { h, service } = svc(fakeAdapter({ createJob: async () => ({ ok: false, reason: 'drift', drift: { drifted: true, currentHash: 'a', expectedHash: 'b' } }) }))
    const r = await service.create({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('drift')
    expect(listJobs(h.db)).toHaveLength(0) // rolled back
    h.close()
  })
})

describe('jobs.service remove', () => {
  it('deletes the native line then the DB row', async () => {
    const { h, service } = svc(fakeAdapter())
    const created = await service.create({ name: 'X', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    const r = await service.remove(created.job!.id)
    expect(r.ok).toBe(true)
    expect(getJob(h.db, created.job!.id)).toBeUndefined()
    h.close()
  })
  it('returns not_found for an unknown id without calling the adapter', async () => {
    let called = false
    const { h, service } = svc(fakeAdapter({ deleteJob: async () => { called = true; return { ok: true } } }))
    const r = await service.remove(999)
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('not_found')
    expect(called).toBe(false)
    h.close()
  })
})

describe('jobs.service adopt', () => {
  it('inserts a DB row per item then calls adoptMany; keeps only the adopted ids', async () => {
    let got: number[] = []
    const { h, service } = svc(fakeAdapter({
      adoptMany: async (specs) => { got = specs.map((s) => s.chronosId); return { ok: true, adopted: got } }
    }))
    const r = await service.adopt([
      { scheduleExpr: '0 3 * * *', command: '/b.sh' },
      { scheduleExpr: '30 4 * * *', command: '/c.sh' }
    ])
    expect(r.ok).toBe(true)
    expect(r.adopted).toHaveLength(2)
    expect(listJobs(h.db).every((j) => j.adopted)).toBe(true)
    expect(got).toEqual(listJobs(h.db).map((j) => j.id))
    h.close()
  })

  it('rolls back DB rows that the adapter did not adopt', async () => {
    const { h, service } = svc(fakeAdapter({
      adoptMany: async (specs) => ({ ok: false, reason: 'error', errorCode: 'no_match', error: 'x', adopted: [specs[0].chronosId] })
    }))
    const r = await service.adopt([
      { scheduleExpr: '0 3 * * *', command: '/b.sh' },
      { scheduleExpr: '30 4 * * *', command: '/c.sh' }
    ])
    expect(r.ok).toBe(false)
    expect(listJobs(h.db)).toHaveLength(1) // only the adopted one survives
    h.close()
  })
})

describe('jobs.service unadopt', () => {
  it('unadopts on the adapter then clears adopted in the DB (keeps the row)', async () => {
    const order: string[] = []
    const { h, service } = svc(fakeAdapter({
      adoptMany: async (specs) => { order.push('adoptMany'); return { ok: true, adopted: specs.map((s) => s.chronosId) } },
      unadopt: async () => { order.push('unadopt'); return { ok: true } }
    }))
    await service.adopt([{ scheduleExpr: '0 3 * * *', command: '/b.sh' }])
    const id = listJobs(h.db)[0].id
    const r = await service.unadopt(id)
    expect(r.ok).toBe(true)
    expect(getJob(h.db, id)?.adopted).toBe(false)
    expect(getJob(h.db, id)).toBeDefined() // row kept (recovery backup + history)
    expect(order).toEqual(['adoptMany', 'unadopt'])
    h.close()
  })
})

describe('jobs.service list', () => {
  it('reconciles adapter.list() against the DB', async () => {
    const native: ParsedJob[] = [{ chronosId: null, scheduleExpr: '0 9 * * *', scheduleExprFormat: 'cron', command: '/u.sh', adopted: false, enabled: true }]
    const { h, service } = svc(fakeAdapter({ list: async () => native }))
    const r = await service.list()
    expect(r.items[0].status).toBe('unmanaged')
    h.close()
  })
})

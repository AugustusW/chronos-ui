// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../db/helpers'
import { createRepositories } from '../../src/main/db/repositories'
import { getJob, listJobs } from '../../src/main/db/jobs.repository'
import { createJobsService } from '../../src/main/services/jobs.service'
import type { SchedulerAdapter, WriteResult, ParsedJob } from '../../src/main/scheduler/types'

function fakeAdapter(over: Partial<SchedulerAdapter> = {}): SchedulerAdapter {
  const ok = async (): Promise<WriteResult> => ({ ok: true })
  return {
    list: async () => [], createJob: ok, updateJob: ok, enableJob: ok, disableJob: ok,
    deleteJob: ok, adopt: ok, unadopt: ok, detectDrift: async () => ({ drifted: false, currentHash: '', expectedHash: '' }),
    adoptMany: async () => ({ ok: true, adopted: [] }), ...over
  }
}

function svc(adapter: SchedulerAdapter) {
  const h = makeTestDb()
  const repos = createRepositories(h)
  return { h, service: createJobsService({ repos, adapter, platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' }) }
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

  it('defaults the adopted name to blank (not the command) when the native entry has no name — cron (#8)', async () => {
    const { h, service } = svc(fakeAdapter({ adoptMany: async (specs) => ({ ok: true, adopted: specs.map((s) => s.chronosId) }) }))
    await service.adopt([{ scheduleExpr: '0 3 * * *', command: '/very/long/path/to/script.sh --flag >> /var/log/x.log 2>&1' }])
    expect(listJobs(h.db)[0].name).toBe('') // blank — user names it; NOT the command
    h.close()
  })

  it('uses the native name as the adopted name when present — Windows Task Scheduler (#8)', async () => {
    const { h, service } = svc(fakeAdapter({ adoptMany: async (specs) => ({ ok: true, adopted: specs.map((s) => s.chronosId) }) }))
    await service.adopt([{ name: 'BackupJob', scheduleExpr: '0 3 * * *', command: 'C:\\backup\\run.exe' }])
    expect(listJobs(h.db)[0].name).toBe('BackupJob')
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

describe('jobs.service update', () => {
  // Mimics the crontab adapter's guard: an adopted (schedmgr-wrapped) job rejects any update
  // that carries a `command` ("cannot change an adopted job's command"). Records its calls so
  // we can assert the service only reaches the native scheduler when schedule/command change.
  function adoptedGuardAdapter(): { adapter: SchedulerAdapter; calls: Array<{ scheduleExpr?: string; command?: string }> } {
    const calls: Array<{ scheduleExpr?: string; command?: string }> = []
    const adapter = fakeAdapter({
      updateJob: async (_id, changes) => {
        calls.push(changes)
        if (changes.command !== undefined) {
          return { ok: false, reason: 'error', error: 'cannot change command of an adopted job; unadopt then adopt' }
        }
        return { ok: true }
      }
    })
    return { adapter, calls }
  }

  it('persists a name-only edit without touching the native scheduler (adopted jobs stay renamable)', async () => {
    const { adapter, calls } = adoptedGuardAdapter()
    const { h, service } = svc(adapter)
    const created = await service.create({ name: 'orig', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    const r = await service.update(created.job!.id, { name: 'Renamed', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    expect(r.ok).toBe(true)
    expect(getJob(h.db, created.job!.id)?.name).toBe('Renamed')
    expect(calls).toEqual([]) // schedule + command unchanged → the adapter must not be called
    h.close()
  })

  it('forwards only the changed schedule (not the unchanged command) so a schedule edit on an adopted job succeeds', async () => {
    const { adapter, calls } = adoptedGuardAdapter()
    const { h, service } = svc(adapter)
    const created = await service.create({ name: 'orig', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    const r = await service.update(created.job!.id, { name: 'orig', scheduleExpr: '0 4 * * *', command: '/b.sh' })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].scheduleExpr).toBe('0 4 * * *')
    expect(calls[0].command).toBeUndefined() // unchanged command not re-sent → adopted guard not tripped
    expect(getJob(h.db, created.job!.id)?.scheduleExpr).toBe('0 4 * * *')
    h.close()
  })

  it('still rejects a genuine command change on an adopted job (guard preserved, DB unchanged)', async () => {
    const { adapter } = adoptedGuardAdapter()
    const { h, service } = svc(adapter)
    const created = await service.create({ name: 'orig', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    const r = await service.update(created.job!.id, { name: 'orig', scheduleExpr: '0 3 * * *', command: '/CHANGED.sh' })
    expect(r.ok).toBe(false)
    expect(getJob(h.db, created.job!.id)?.command).toBe('/b.sh')
    h.close()
  })
})

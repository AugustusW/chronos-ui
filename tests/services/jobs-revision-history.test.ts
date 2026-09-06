// SPDX-License-Identifier: Apache-2.0
// The revision log is only worth anything if it records the changes that actually happen, through
// every path that changes a job. The adopt/unadopt cases carry the most weight: on crontab an
// adopted job's command CANNOT be edited in place (the adapter refuses), so the round trip is the
// only way it changes — a history that skipped it would be blank exactly where cron mistakes live.
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../db/helpers'
import { createRepositories } from '../../src/main/db/repositories'
import { createJobsService } from '../../src/main/services/jobs.service'
import { listRevisionsForJob } from '../../src/main/db/jobRevisions.repository'
import type { SchedulerAdapter, WriteResult, ParsedJob } from '../../src/main/scheduler/types'

function fakeAdapter(over: Partial<SchedulerAdapter> = {}): SchedulerAdapter {
  const ok = async (): Promise<WriteResult> => ({ ok: true })
  return {
    list: async () => [], createJob: ok, updateJob: ok, enableJob: ok, disableJob: ok,
    deleteJob: ok, adopt: ok, unadopt: ok,
    detectDrift: async () => ({ drifted: false, currentHash: '', expectedHash: '' }),
    adoptMany: async () => ({ ok: true, adopted: [] }),
    releaseAll: async () => ({ ok: true, released: [], skipped: [] }),
    installFlushEntry: ok, removeFlushEntry: ok, ...over
  }
}

function svc(adapter: SchedulerAdapter) {
  const h = makeTestDb()
  const repos = createRepositories(h)
  return { h, repos, service: createJobsService({ repos, adapter, platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' }) }
}

async function seed(service: ReturnType<typeof svc>['service']) {
  const r = await service.create({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' })
  return r.job!
}

describe('revision history — user edits', () => {
  it('records an edit with only the changed field on each side', async () => {
    const { h, service } = svc(fakeAdapter())
    const job = await seed(service)
    await service.update(job.id, { name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup2.sh' })

    const revs = listRevisionsForJob(h.db, job.id)
    expect(revs).toHaveLength(1)
    expect(revs[0].source).toBe('edit')
    expect(revs[0].changedFields).toEqual(['command'])
    expect(revs[0].before).toEqual({ command: '/usr/bin/backup.sh' })
    expect(revs[0].after).toEqual({ command: '/usr/bin/backup2.sh' })
  })

  it('writes NOTHING when the editor re-sends an unchanged form', async () => {
    const { h, service } = svc(fakeAdapter())
    const job = await seed(service)
    await service.update(job.id, { name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' })
    expect(listRevisionsForJob(h.db, job.id)).toEqual([])
  })

  it('does not record when the native write fails (no revision for a change that never landed)', async () => {
    const { h, service } = svc(fakeAdapter({ updateJob: async () => ({ ok: false, reason: 'error', error: 'boom' }) }))
    const job = await seed(service)
    const r = await service.update(job.id, { command: '/usr/bin/other.sh' })
    expect(r.ok).toBe(false)
    expect(listRevisionsForJob(h.db, job.id)).toEqual([])
  })

  it('records enable and disable — a silently disabled job is exactly what history is for', async () => {
    const { h, service } = svc(fakeAdapter())
    const job = await seed(service)
    await service.disable(job.id)
    await service.enable(job.id)

    const revs = listRevisionsForJob(h.db, job.id)
    expect(revs.map((r) => r.after.enabled)).toEqual([true, false]) // newest first
    expect(revs.every((r) => r.changedFields.length === 1 && r.changedFields[0] === 'enabled')).toBe(true)
  })
})

describe('revision history — adopt / unadopt', () => {
  it('records the adopt that takes over an existing native line', async () => {
    const { h, service } = svc(fakeAdapter({ adoptMany: async (specs) => ({ ok: true, adopted: specs.map((s) => s.chronosId) }) }))
    const r = await service.adopt([{ scheduleExpr: '0 4 * * *', command: '/usr/bin/legacy.sh', native: {} as never }])
    expect(r.ok).toBe(true)
    const jobId = r.adopted[0]

    const revs = listRevisionsForJob(h.db, jobId)
    expect(revs).toHaveLength(1)
    expect(revs[0].source).toBe('adopt')
    expect(revs[0].changedFields).toEqual(['adopted'])
    expect(revs[0].before).toEqual({ adopted: false })
    expect(revs[0].after).toEqual({ adopted: true })
  })

  it('records nothing for an adopt the adapter refused (the compensating delete removes the row)', async () => {
    const { repos, service } = svc(fakeAdapter({ adoptMany: async () => ({ ok: false, reason: 'error', error: 'no', adopted: [] }) }))
    await service.adopt([{ scheduleExpr: '0 4 * * *', command: '/usr/bin/legacy.sh', native: {} as never }])
    // No job row survived, so there is nothing to have history — assert on the real state rather
    // than a guessed id, which would pass even if the id were wrong.
    expect(await repos.jobs.list()).toEqual([])
  })

  it('undoes the wrap and reports failure when the adopted flag cannot be written', async () => {
    const unadoptCalls: number[] = []
    const { repos, service } = svc(
      fakeAdapter({
        adoptMany: async (specs) => ({ ok: true, adopted: specs.map((s) => s.chronosId) }),
        unadopt: async (id) => {
          unadoptCalls.push(id)
          return { ok: true }
        }
      })
    )
    // The DB flip fails: the line is already wrapped, so reporting success would claim a job is
    // adopted while the DB says it is not — and leave no history of either.
    const realUpdate = repos.jobs.update
    repos.jobs.update = async (id, patch) => ('adopted' in patch ? undefined : realUpdate(id, patch))
    const r = await service.adopt([{ scheduleExpr: '0 4 * * *', command: '/usr/bin/legacy.sh', native: {} as never }])

    expect(r.ok).toBe(false)
    expect(r.adopted).toEqual([])
    expect(unadoptCalls).toHaveLength(1) // wrap undone, not left behind
    expect(await repos.jobs.list()).toEqual([])
  })

  it('records the unadopt that hands a job back', async () => {
    const { h, service } = svc(fakeAdapter({ adoptMany: async (specs) => ({ ok: true, adopted: specs.map((s) => s.chronosId) }) }))
    const r = await service.adopt([{ scheduleExpr: '0 4 * * *', command: '/usr/bin/legacy.sh', native: {} as never }])
    const jobId = r.adopted[0]
    await service.unadopt(jobId)

    const revs = listRevisionsForJob(h.db, jobId)
    expect(revs[0].source).toBe('unadopt')
    expect(revs[0].before).toEqual({ adopted: true })
    expect(revs[0].after).toEqual({ adopted: false })
    expect(revs).toHaveLength(2) // adopt, then unadopt
  })

  it('does not record an unadopt the adapter refused', async () => {
    const { h, service } = svc(
      fakeAdapter({
        adoptMany: async (specs) => ({ ok: true, adopted: specs.map((s) => s.chronosId) }),
        unadopt: async () => ({ ok: false, reason: 'error', error: 'nope' })
      })
    )
    const r = await service.adopt([{ scheduleExpr: '0 4 * * *', command: '/usr/bin/legacy.sh', native: {} as never }])
    const jobId = r.adopted[0]
    await service.unadopt(jobId)
    expect(listRevisionsForJob(h.db, jobId).map((x) => x.source)).toEqual(['adopt'])
  })
})

describe('revision history — external edits', () => {
  const drifted = (over: Partial<ParsedJob>): ParsedJob => ({
    chronosId: 1, scheduleExpr: '0 3 * * *', scheduleExprFormat: 'cron',
    command: '/usr/bin/backup.sh', adopted: false, enabled: true, ...over
  })

  it('records an edit made outside the app, with the DB row as the before value', async () => {
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: '/usr/bin/HACKED.sh' })] }))
    const job = await seed(service)
    await service.list()

    const revs = listRevisionsForJob(h.db, job.id)
    expect(revs).toHaveLength(1)
    expect(revs[0].source).toBe('external')
    expect(revs[0].changedFields).toEqual(['command'])
    expect(revs[0].before).toEqual({ command: '/usr/bin/backup.sh' })
    expect(revs[0].after).toEqual({ command: '/usr/bin/HACKED.sh' })
  })

  it('does not write a second row while the same drift is still unresolved', async () => {
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: '/usr/bin/HACKED.sh' })] }))
    const job = await seed(service)
    await service.list()
    await service.list()
    await service.list()
    expect(listRevisionsForJob(h.db, job.id)).toHaveLength(1)
  })

  it('records again when the external value changes a second time', async () => {
    let current = '/usr/bin/one.sh'
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: current })] }))
    const job = await seed(service)
    await service.list()
    current = '/usr/bin/two.sh'
    await service.list()

    const revs = listRevisionsForJob(h.db, job.id)
    expect(revs.map((r) => r.after.command)).toEqual(['/usr/bin/two.sh', '/usr/bin/one.sh'])
  })

  it('writes nothing when native and DB agree', async () => {
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({})] }))
    const job = await seed(service)
    await service.list()
    expect(listRevisionsForJob(h.db, job.id)).toEqual([])
  })

  it('list() still returns its reconcile result when recording is impossible', async () => {
    const { service, repos } = svc(fakeAdapter({ list: async () => [drifted({ command: '/usr/bin/HACKED.sh' })] }))
    await seed(service)
    repos.jobRevisions.record = async () => {
      throw new Error('disk full')
    }
    const result = await service.list()
    expect(result.items.some((i) => i.status === 'drifted')).toBe(true)
  })
})

describe('revision history — failure and concurrency', () => {
  const drifted = (over: Partial<ParsedJob>): ParsedJob => ({
    chronosId: 1, scheduleExpr: '0 3 * * *', scheduleExprFormat: 'cron',
    command: '/usr/bin/backup.sh', adopted: false, enabled: true, ...over
  })

  it('reports a db_error instead of success when the DB write is lost after the native write', async () => {
    const { h, repos, service } = svc(fakeAdapter())
    const job = await seed(service)
    repos.jobs.update = async () => undefined
    const r = await service.update(job.id, { command: '/usr/bin/other.sh' })
    // The scheduler has already been changed; claiming ok:true would tell the user an edit landed
    // that our own records do not have.
    expect(r.ok).toBe(false)
    expect('errorCode' in r && r.errorCode).toBe('db_error')
    expect(listRevisionsForJob(h.db, job.id)).toEqual([])
  })

  it('records an external change once across concurrent list() calls', async () => {
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: '/usr/bin/HACKED.sh' })] }))
    const job = await seed(service)
    // Three views mounting at once, or a jobsChanged burst. Without sharing the in-flight read,
    // each call reads "nothing recorded yet" before any of them writes.
    await Promise.all([service.list(), service.list(), service.list()])
    expect(listRevisionsForJob(h.db, job.id)).toHaveLength(1)
  })

  it('records the same external change again after it was undone and repeated', async () => {
    let current = '/usr/bin/backup.sh'
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: current })] }))
    const job = await seed(service)

    current = '/usr/bin/EVIL.sh'
    await service.list() // recorded
    current = '/usr/bin/backup.sh'
    await service.list() // back in sync — no drift, nothing recorded, and no marker left behind
    current = '/usr/bin/EVIL.sh'
    await service.list() // the SAME values drifting again is a new event, not a repeat

    const revs = listRevisionsForJob(h.db, job.id)
    // newest first: the repeat, the closure of the first one, and the first one
    expect(revs.map((r) => r.source)).toEqual(['external', 'resolved', 'external'])
    expect(revs.filter((r) => r.source === 'external').every((r) => r.after.command === '/usr/bin/EVIL.sh')).toBe(true)
  })

  it('records nothing for a job whose native entry was deleted outside the app', async () => {
    // `vanished` carries no native side, so there is no after-value to diff against. The status is
    // surfaced in the job list; the change log deliberately stays out of it. Pinned so that a
    // future change to record deletions is a deliberate decision, not an accident.
    const { h, service } = svc(fakeAdapter({ list: async () => [] }))
    const job = await seed(service)
    const result = await service.list()
    expect(result.items.some((i) => i.status === 'vanished')).toBe(true)
    expect(listRevisionsForJob(h.db, job.id)).toEqual([])
  })

  it('keeps recording other jobs when one job\'s revision write fails', async () => {
    const { h, repos, service } = svc(
      fakeAdapter({
        list: async () => [
          drifted({ chronosId: 1, command: '/usr/bin/one.sh' }),
          drifted({ chronosId: 2, command: '/usr/bin/two.sh' })
        ]
      })
    )
    const a = await seed(service)
    const b = await seed(service)
    const realRecord = repos.jobRevisions.record
    repos.jobRevisions.record = async (input) => {
      if (input.jobId === a.id) throw new Error('disk full')
      return realRecord(input)
    }
    await service.list()
    expect(listRevisionsForJob(h.db, a.id)).toEqual([])
    expect(listRevisionsForJob(h.db, b.id)).toHaveLength(1)
  })
})

describe('restoreToScheduler', () => {
  it('pushes the DB values into the scheduler even though they equal the DB row', async () => {
    // This is the whole point: update() compares against the DB row and would skip the adapter,
    // changing nothing while reporting success.
    const calls: unknown[] = []
    const { service } = svc(fakeAdapter({ updateJob: async (id, changes) => { calls.push([id, changes]); return { ok: true } } }))
    const job = await seed(service)
    const r = await service.restoreToScheduler(job.id)
    expect(r.ok).toBe(true)
    expect(calls).toEqual([[job.id, { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' }]])
  })

  it('returns the adapter refusal verbatim rather than working around it', async () => {
    const { service } = svc(fakeAdapter({ updateJob: async () => ({ ok: false, reason: 'error', error: 'cannot change command of an adopted job; unadopt then adopt' }) }))
    const job = await seed(service)
    const r = await service.restoreToScheduler(job.id)
    expect(r.ok).toBe(false)
    expect('error' in r && r.error).toContain('adopted job')
  })

  it('reports not_found for a job that does not exist', async () => {
    const { service } = svc(fakeAdapter())
    const r = await service.restoreToScheduler(999)
    expect('errorCode' in r && r.errorCode).toBe('not_found')
  })
})

describe('revision history — closing out a drift', () => {
  const drifted = (over: Partial<ParsedJob>): ParsedJob => ({
    chronosId: 1, scheduleExpr: '0 3 * * *', scheduleExprFormat: 'cron',
    command: '/usr/bin/backup.sh', adopted: false, enabled: true, ...over
  })

  it('records that the scheduler was put back, read the other way round', async () => {
    let current = '/usr/bin/backup.sh'
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: current })] }))
    const job = await seed(service)

    current = '/usr/bin/EVIL.sh'
    await service.list()
    current = '/usr/bin/backup.sh'
    await service.list()

    const revs = listRevisionsForJob(h.db, job.id)
    expect(revs.map((r) => r.source)).toEqual(['resolved', 'external'])
    // Without this row a job's history ends at "changed to EVIL" long after someone put it back.
    expect(revs[0].before).toEqual({ command: '/usr/bin/EVIL.sh' })
    expect(revs[0].after).toEqual({ command: '/usr/bin/backup.sh' })
  })

  it('writes the resolution once, not on every poll', async () => {
    let current = '/usr/bin/backup.sh'
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: current })] }))
    const job = await seed(service)
    current = '/usr/bin/EVIL.sh'
    await service.list()
    current = '/usr/bin/backup.sh'
    await service.list()
    await service.list()
    await service.list()
    expect(listRevisionsForJob(h.db, job.id)).toHaveLength(2)
  })

  it('writes nothing for a job that was never drifted', async () => {
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({})] }))
    const job = await seed(service)
    await service.list()
    expect(listRevisionsForJob(h.db, job.id)).toEqual([])
  })

  it('does not call a DELETED entry "put back"', async () => {
    // The job must actually drift first, or this passes under any implementation: a job that never
    // drifted has nothing to close out. Deleting the line is not a resolution — nothing is running.
    let native: ParsedJob[] = [drifted({ command: '/usr/bin/EVIL.sh' })]
    const { h, service } = svc(fakeAdapter({ list: async () => native }))
    const job = await seed(service)
    await service.list()
    native = [] // someone deleted the crontab line
    const result = await service.list()

    expect(result.items.some((i) => i.status === 'vanished')).toBe(true)
    expect(listRevisionsForJob(h.db, job.id).map((r) => r.source)).toEqual(['external'])
  })

  it('records where the scheduler actually ended up, not where it started', async () => {
    // Drift a → b, then the user accepts it by editing the job to a THIRD value. Inverting the
    // stored row would claim the scheduler is back at `a`, a state that never existed anywhere.
    let current = '/usr/bin/a.sh'
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ command: current })] }))
    const job = await seed(service)
    await service.update(job.id, { command: '/usr/bin/a.sh' })

    current = '/usr/bin/b.sh'
    await service.list()
    // the user resolves it by editing the job to c; the scheduler follows
    await service.update(job.id, { command: '/usr/bin/c.sh' })
    current = '/usr/bin/c.sh'
    await service.list()

    const resolved = listRevisionsForJob(h.db, job.id).find((r) => r.source === 'resolved')!
    expect(resolved.before).toEqual({ command: '/usr/bin/b.sh' })
    expect(resolved.after).toEqual({ command: '/usr/bin/c.sh' })
  })

  it('does not repeat a difference that is still standing when another field is put back', async () => {
    let sched = '0 3 * * *'
    let cmd = '/usr/bin/backup.sh'
    const { h, service } = svc(fakeAdapter({ list: async () => [drifted({ scheduleExpr: sched, command: cmd })] }))
    const job = await seed(service)

    sched = '*/5 * * * *'
    cmd = '/usr/bin/EVIL.sh'
    await service.list() // one external covering both fields
    cmd = '/usr/bin/backup.sh' // command put back; schedule still wrong
    await service.list()

    const revs = listRevisionsForJob(h.db, job.id)
    // The schedule difference is unchanged, so it must not be recorded a second time — that would
    // read as the same edit having been made twice.
    expect(revs).toHaveLength(1)
    expect(revs[0].changedFields.sort()).toEqual(['command', 'scheduleExpr'])
  })

  it('retries the resolution write after a transient failure', async () => {
    let current = '/usr/bin/backup.sh'
    const { h, repos, service } = svc(fakeAdapter({ list: async () => [drifted({ command: current })] }))
    const job = await seed(service)
    current = '/usr/bin/EVIL.sh'
    await service.list()
    current = '/usr/bin/backup.sh'

    const real = repos.jobRevisions.record
    let failed = false
    repos.jobRevisions.record = async (input) => {
      if (input.source === 'resolved' && !failed) {
        failed = true
        throw new Error('disk full')
      }
      return real(input)
    }
    await service.list() // fails
    await service.list() // must try again, not treat the job as handled for the process
    expect(listRevisionsForJob(h.db, job.id).map((r) => r.source)).toEqual(['resolved', 'external'])
  })

  it('records a recurrence that happened while the app was closed', async () => {
    // The whole point of storing the resolution: a NEW process has no memory of the earlier drift,
    // so "is this the same standing drift or the same edit made again?" has to be answerable from
    // the database. Two services over ONE database stand in for a restart.
    let current = '/usr/bin/backup.sh'
    const h = makeTestDb()
    const repos = createRepositories(h)
    const adapter = fakeAdapter({ list: async () => [drifted({ command: current })] })
    const mk = () => createJobsService({ repos, adapter, platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    const first = mk()
    const created = await first.create({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' })
    const jobId = created.job!.id
    current = '/usr/bin/EVIL.sh'
    await first.list() // external recorded
    current = '/usr/bin/backup.sh'
    await first.list() // resolved recorded

    // app restarts; the same edit is made again
    current = '/usr/bin/EVIL.sh'
    await mk().list()

    const revs = listRevisionsForJob(h.db, jobId)
    expect(revs.map((r) => r.source)).toEqual(['external', 'resolved', 'external'])
  })

  it('still de-duplicates a standing drift across a restart', async () => {
    // The mirror case: nothing changed while the app was closed, so re-observing the SAME standing
    // drift must not add a second row.
    let current = '/usr/bin/backup.sh'
    const h = makeTestDb()
    const repos = createRepositories(h)
    const adapter = fakeAdapter({ list: async () => [drifted({ command: current })] })
    const mk = () => createJobsService({ repos, adapter, platform: 'darwin', schedmgrPath: '/opt/schedmgr', dbPath: ':memory:' })

    const first = mk()
    const created = await first.create({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' })
    current = '/usr/bin/EVIL.sh'
    await first.list()
    await mk().list() // restart, drift never resolved

    expect(listRevisionsForJob(h.db, created.job!.id)).toHaveLength(1)
  })
})

describe('forget() consults the scheduler, not just the DB flag', () => {
  it('refuses to forget a row whose scheduler entry is still wrapped', async () => {
    // adopt()'s compensation keeps the row when the unwrap fails, so the row can say adopted:false
    // while the line is wrapped. Forgetting it would strand that line with nothing left that
    // remembers its original command — the outcome keeping the row exists to prevent.
    const { repos, service } = svc(
      fakeAdapter({
        list: async () => [
          { chronosId: 1, scheduleExpr: '0 4 * * *', scheduleExprFormat: 'cron', command: '/usr/bin/legacy.sh', adopted: true, enabled: true }
        ]
      })
    )
    const created = await repos.jobs.create({
      name: 'legacy', source: 'native_cron', platform: 'darwin',
      scheduleExpr: '0 4 * * *', command: '/usr/bin/legacy.sh', adopted: false
    })
    const r = await service.forget(created.id)
    expect(r.ok).toBe(false)
    expect('error' in r && r.error).toContain('adopted job')
    expect(await repos.jobs.get(created.id)).toBeDefined()
  })

  it('still forgets an ordinary unadopted job', async () => {
    const { repos, service } = svc(
      fakeAdapter({
        list: async () => [
          { chronosId: 1, scheduleExpr: '0 4 * * *', scheduleExprFormat: 'cron', command: '/usr/bin/plain.sh', adopted: false, enabled: true }
        ]
      })
    )
    const created = await repos.jobs.create({
      name: 'plain', source: 'native_cron', platform: 'darwin',
      scheduleExpr: '0 4 * * *', command: '/usr/bin/plain.sh', adopted: false
    })
    expect((await service.forget(created.id)).ok).toBe(true)
    expect(await repos.jobs.get(created.id)).toBeUndefined()
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb } from './helpers'
import type { DatabaseHandle } from '../../src/main/db/client'
import { createJob, deleteJob } from '../../src/main/db/jobs.repository'
import {
  recordRevision,
  listRevisionsForJob,
  getLatestRevision
} from '../../src/main/db/jobRevisions.repository'

let h: DatabaseHandle

const sample = {
  name: 'Nightly backup',
  source: 'native_cron' as const,
  platform: 'darwin' as const,
  scheduleExpr: '0 3 * * *',
  command: '/usr/bin/backup.sh'
}

function seedJob(): number {
  return createJob(h.db, sample).id
}

beforeEach(() => {
  h = makeTestDb()
})
afterEach(() => h.close())

describe('jobRevisions.repository', () => {
  it('records a revision and reads it back with json round-tripped', () => {
    const jobId = seedJob()
    const rev = recordRevision(h.db, {
      jobId,
      source: 'edit',
      changedFields: ['command'],
      before: { command: 'a' },
      after: { command: 'b' }
    })
    expect(rev.id).toBeGreaterThan(0)
    expect(rev.changedAt).toBeInstanceOf(Date)
    expect(rev.changedFields).toEqual(['command'])
    expect(rev.before).toEqual({ command: 'a' })
    expect(rev.after).toEqual({ command: 'b' })
  })

  it('round-trips a nested env object (json mode, not a stringified blob)', () => {
    const jobId = seedJob()
    recordRevision(h.db, {
      jobId,
      source: 'edit',
      changedFields: ['env'],
      before: { env: null },
      after: { env: { TOKEN: 'x', PATH: '/usr/bin' } }
    })
    const [row] = listRevisionsForJob(h.db, jobId)
    expect(row.after).toEqual({ env: { TOKEN: 'x', PATH: '/usr/bin' } })
  })

  it('lists most recent first and honours the limit', () => {
    const jobId = seedJob()
    for (let i = 0; i < 5; i++) {
      recordRevision(h.db, {
        jobId,
        source: 'edit',
        changedFields: ['command'],
        before: { command: `c${i}` },
        after: { command: `c${i + 1}` },
        changedAt: new Date(1_700_000_000_000 + i * 1000)
      })
    }
    const rows = listRevisionsForJob(h.db, jobId, 3)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.after.command)).toEqual(['c5', 'c4', 'c3'])
  })

  it('breaks ties on id so same-millisecond revisions still order newest first', () => {
    const jobId = seedJob()
    const at = new Date(1_700_000_000_000)
    const first = recordRevision(h.db, { jobId, source: 'edit', changedFields: ['name'], before: {}, after: {}, changedAt: at })
    const second = recordRevision(h.db, { jobId, source: 'edit', changedFields: ['name'], before: {}, after: {}, changedAt: at })
    expect(listRevisionsForJob(h.db, jobId).map((r) => r.id)).toEqual([second.id, first.id])
  })

  it('scopes to one job', () => {
    const a = seedJob()
    const b = seedJob()
    recordRevision(h.db, { jobId: a, source: 'edit', changedFields: ['name'], before: {}, after: {} })
    expect(listRevisionsForJob(h.db, b)).toEqual([])
  })

  it('getLatestRevision returns the newest, optionally filtered by source', () => {
    const jobId = seedJob()
    recordRevision(h.db, { jobId, source: 'external', changedFields: ['command'], before: { command: 'x' }, after: { command: 'y' }, changedAt: new Date(1000) })
    recordRevision(h.db, { jobId, source: 'edit', changedFields: ['command'], before: { command: 'y' }, after: { command: 'z' }, changedAt: new Date(2000) })
    expect(getLatestRevision(h.db, jobId)?.source).toBe('edit')
    expect(getLatestRevision(h.db, jobId, 'external')?.after).toEqual({ command: 'y' })
    expect(getLatestRevision(h.db, jobId, 'unadopt')).toBeUndefined()
  })

  it('cascades when the job is deleted (no orphan history)', () => {
    const jobId = seedJob()
    recordRevision(h.db, { jobId, source: 'edit', changedFields: ['name'], before: {}, after: {} })
    deleteJob(h.db, jobId)
    expect(listRevisionsForJob(h.db, jobId)).toEqual([])
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeTestDb } from './helpers'
import type { DatabaseHandle } from '../../src/main/db/client'
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
  deleteJob,
  setJobCachedRun
} from '../../src/main/db/jobs.repository'

let h: DatabaseHandle

const sample = {
  name: 'Nightly backup',
  source: 'native_cron' as const,
  platform: 'darwin' as const,
  scheduleExpr: '0 3 * * *',
  command: '/usr/bin/python3 /Users/me/backup.py'
}

beforeEach(() => {
  h = makeTestDb()
})
afterEach(() => h.close())

describe('jobs.repository', () => {
  it('creates a job with defaults and reads it back', () => {
    const created = createJob(h.db, sample)
    expect(created.id).toBeGreaterThan(0)
    expect(created.enabled).toBe(true)
    expect(created.adopted).toBe(false)
    expect(created.createdAt).toBeInstanceOf(Date)
    const fetched = getJob(h.db, created.id)
    expect(fetched?.name).toBe('Nightly backup')
    expect(fetched?.command).toBe(sample.command)
  })

  it('lists jobs and filters by enabled + category', () => {
    createJob(h.db, { ...sample, name: 'a', category: 'ops', enabled: true })
    createJob(h.db, { ...sample, name: 'b', category: 'ops', enabled: false })
    createJob(h.db, { ...sample, name: 'c', category: 'misc', enabled: true })
    expect(listJobs(h.db)).toHaveLength(3)
    expect(listJobs(h.db, { enabled: true })).toHaveLength(2)
    expect(listJobs(h.db, { category: 'ops' })).toHaveLength(2)
    expect(listJobs(h.db, { category: 'ops', enabled: false })).toHaveLength(1)
  })

  it('updates a job and bumps updatedAt', async () => {
    const created = createJob(h.db, sample)
    const before = created.updatedAt.getTime()
    await new Promise((r) => setTimeout(r, 5))
    const updated = updateJob(h.db, created.id, { name: 'Renamed', adopted: true })
    expect(updated?.name).toBe('Renamed')
    expect(updated?.adopted).toBe(true)
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  it('stores and round-trips the env json + persists cached run fields', () => {
    const created = createJob(h.db, { ...sample, env: { PATH: '/usr/bin', TZ: 'UTC' } })
    expect(getJob(h.db, created.id)?.env).toEqual({ PATH: '/usr/bin', TZ: 'UTC' })
    const when = new Date()
    setJobCachedRun(h.db, created.id, { lastRunAt: when, lastResult: 'success' })
    const after = getJob(h.db, created.id)
    expect(after?.lastResult).toBe('success')
    expect(after?.lastRunAt?.getTime()).toBe(when.getTime())
  })

  it('setJobCachedRun does not bump updatedAt (a run is not a config change)', async () => {
    const created = createJob(h.db, sample)
    const before = created.updatedAt.getTime()
    await new Promise((r) => setTimeout(r, 5))
    setJobCachedRun(h.db, created.id, { lastRunAt: new Date(), lastResult: 'success' })
    expect(getJob(h.db, created.id)!.updatedAt.getTime()).toBe(before)
  })

  it('deletes a job', () => {
    const created = createJob(h.db, sample)
    deleteJob(h.db, created.id)
    expect(getJob(h.db, created.id)).toBeUndefined()
  })
})

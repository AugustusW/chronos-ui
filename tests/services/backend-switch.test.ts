// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { testConnection, rebakeDescriptors, type PgClientLike, type RebakeDeps } from '../../src/main/services/backend-switch'
import type { AdoptOptions, WriteResult } from '../../src/main/scheduler/types'
import type { Job } from '../../src/main/db/schema'

function fakeClient(over: Partial<PgClientLike> = {}): PgClientLike {
  return {
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [{ version: 'PostgreSQL 16.4' }] })),
    end: vi.fn(async () => {}),
    ...over
  }
}

describe('testConnection (unit, mocked pg.Client)', () => {
  it('returns ok + version + elapsed ms on a successful connect', async () => {
    const client = fakeClient()
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:p@host:5432/db', factory)
    expect(factory).toHaveBeenCalledWith('postgresql://u:p@host:5432/db')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.version).toBe('PostgreSQL 16.4')
      expect(res.ms).toBeGreaterThanOrEqual(0)
    }
    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.query).toHaveBeenCalledWith('SELECT version()')
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('returns ok:false with a redacted error when connect() rejects', async () => {
    const client = fakeClient({ connect: vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432') }) })
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:p@host:5432/db', factory)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('connect ECONNREFUSED 127.0.0.1:5432')
    // client.end is still attempted (best-effort cleanup) even though connect failed.
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('redacts the password if the underlying driver error embeds the raw DSN', async () => {
    const client = fakeClient({
      connect: vi.fn(async () => {
        throw new Error('invalid connection string: postgresql://u:SECRET@host:5432/db')
      })
    })
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:SECRET@host:5432/db', factory)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).not.toContain('SECRET')
      expect(res.error).toContain('***')
    }
  })

  it('returns ok:false when query() rejects (e.g. auth failure after connect)', async () => {
    const client = fakeClient({ query: vi.fn(async () => { throw new Error('password authentication failed for user "u"') }) })
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:p@host:5432/db', factory)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('password authentication failed for user "u"')
  })
})

// Minimal fixtures for rebakeDescriptors — only the `id`/`scheduleExpr`/`command`/`adopted` fields
// it actually reads are populated; the rest of Job is irrelevant to this function.
function job(over: Partial<Job> & Pick<Job, 'id' | 'scheduleExpr' | 'command' | 'adopted'>): Job {
  return {
    name: '',
    source: 'native_cron',
    platform: 'darwin',
    workingDir: null,
    env: null,
    enabled: true,
    timeoutSec: null,
    category: null,
    notifyOnFailure: false,
    lastRunAt: null,
    lastResult: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over
  }
}

function fakeRebakeAdapter(
  over: Partial<{ unadopt: RebakeDeps['adapter']['unadopt']; adopt: RebakeDeps['adapter']['adopt'] }> = {}
): { adapter: RebakeDeps['adapter']; calls: { unadopt: Array<[number, string]>; adopt: Array<[number, AdoptOptions]> } } {
  const calls = { unadopt: [] as Array<[number, string]>, adopt: [] as Array<[number, AdoptOptions]> }
  const ok: WriteResult = { ok: true }
  const adapter: RebakeDeps['adapter'] = {
    unadopt: over.unadopt ?? (async (id, cmd) => { calls.unadopt.push([id, cmd]); return ok }),
    adopt: over.adopt ?? (async (id, opts) => { calls.adopt.push([id, opts]); return ok })
  }
  return { adapter, calls }
}

describe('rebakeDescriptors (T10, mocked adapter)', () => {
  it('re-bakes the --db descriptor for every adopted job via unadopt+adopt, in schedmgrDbDescriptor order', async () => {
    const { adapter, calls } = fakeRebakeAdapter()
    const jobs = [
      job({ id: 1, scheduleExpr: '0 3 * * *', command: '/a.sh', adopted: true }),
      job({ id: 2, scheduleExpr: '0 4 * * *', command: '/b.sh', adopted: true })
    ]
    const res = await rebakeDescriptors(
      { backend: 'postgres', pgService: 'com.augustusw.chronos-ui/pg-dsn' },
      '/db/chronos.db',
      jobs,
      { adapter, schedmgrPath: '/opt/schedmgr' }
    )
    expect(res).toEqual({ ok: true, rebaked: [1, 2], errors: [] })
    expect(calls.unadopt).toEqual([[1, '/a.sh'], [2, '/b.sh']])
    expect(calls.adopt).toEqual([
      [1, { scheduleExpr: '0 3 * * *', command: '/a.sh', schedmgrPath: '/opt/schedmgr', dbPath: 'pg:keychain:com.augustusw.chronos-ui/pg-dsn' }],
      [2, { scheduleExpr: '0 4 * * *', command: '/b.sh', schedmgrPath: '/opt/schedmgr', dbPath: 'pg:keychain:com.augustusw.chronos-ui/pg-dsn' }]
    ])
  })

  it('re-bakes to the plain sqlite path when switching back (schedmgrDbDescriptor: sqlite)', async () => {
    const { adapter, calls } = fakeRebakeAdapter()
    const jobs = [job({ id: 1, scheduleExpr: '* * * * *', command: '/x.sh', adopted: true })]
    const res = await rebakeDescriptors({ backend: 'sqlite' }, '/db/chronos.db', jobs, { adapter, schedmgrPath: '/opt/schedmgr' })
    expect(res.ok).toBe(true)
    expect(calls.adopt[0][1].dbPath).toBe('/db/chronos.db')
  })

  it('skips jobs that are not adopted (plain created jobs never got the schedmgr wrap)', async () => {
    const { adapter, calls } = fakeRebakeAdapter()
    const jobs = [
      job({ id: 1, scheduleExpr: '* * * * *', command: '/adopted.sh', adopted: true }),
      job({ id: 2, scheduleExpr: '* * * * *', command: '/created.sh', adopted: false })
    ]
    const res = await rebakeDescriptors({ backend: 'sqlite' }, '/db/chronos.db', jobs, { adapter, schedmgrPath: '/opt/schedmgr' })
    expect(res).toEqual({ ok: true, rebaked: [1], errors: [] })
    expect(calls.unadopt.map((c) => c[0])).toEqual([1])
  })

  it('returns ok:true with an empty rebaked list when there are no adopted jobs', async () => {
    const { adapter } = fakeRebakeAdapter()
    const res = await rebakeDescriptors({ backend: 'sqlite' }, '/db/chronos.db', [], { adapter, schedmgrPath: '/opt/schedmgr' })
    expect(res).toEqual({ ok: true, rebaked: [], errors: [] })
  })

  it('records a per-job error (and skips re-adopt) when unadopt fails, but keeps processing the rest', async () => {
    const { adapter, calls } = fakeRebakeAdapter({
      unadopt: async (id) => (id === 1 ? { ok: false, reason: 'error', error: 'boom' } : { ok: true })
    })
    const jobs = [
      job({ id: 1, scheduleExpr: '* * * * *', command: '/a.sh', adopted: true }),
      job({ id: 2, scheduleExpr: '* * * * *', command: '/b.sh', adopted: true })
    ]
    const res = await rebakeDescriptors({ backend: 'sqlite' }, '/db/chronos.db', jobs, { adapter, schedmgrPath: '/opt/schedmgr' })
    expect(res.ok).toBe(false)
    expect(res.rebaked).toEqual([2])
    expect(res.errors).toEqual([{ id: 1, error: 'boom' }])
    // adopt must never be called for the job whose unadopt failed (nothing to re-wrap).
    expect(calls.adopt.map((c) => c[0])).toEqual([2])
  })

  it('records a per-job error when adopt fails after a successful unadopt', async () => {
    const { adapter } = fakeRebakeAdapter({
      adopt: async () => ({ ok: false, reason: 'error', error: 'no matching unadopted line' })
    })
    const jobs = [job({ id: 1, scheduleExpr: '* * * * *', command: '/a.sh', adopted: true })]
    const res = await rebakeDescriptors({ backend: 'sqlite' }, '/db/chronos.db', jobs, { adapter, schedmgrPath: '/opt/schedmgr' })
    expect(res).toEqual({ ok: false, rebaked: [], errors: [{ id: 1, error: 'no matching unadopted line' }] })
  })
})

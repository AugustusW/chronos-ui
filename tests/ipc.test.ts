import { describe, it, expect } from 'vitest'
import { handleGetVersion, handleJobsCreate, handleJobsUpdate, handleJobsAdopt, handleJobsRunNowStreaming, handleJobsRunBatchCancel, handleRunsRecent, MAX_BATCH_ADOPT, MAX_RUN_LIST_LIMIT, type IpcDeps } from '../src/main/ipc'

describe('handleGetVersion', () => {
  it('returns the app name and a semver-shaped version', () => {
    const result = handleGetVersion({ name: 'chronos-ui', version: '0.1.0' })
    expect(result.name).toBe('chronos-ui')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

const deps = (over: Partial<IpcDeps> = {}): IpcDeps => ({
  meta: { name: 'chronos-ui', version: '0.1.0' },
  service: {
    create: async () => ({ ok: true }), update: async () => ({ ok: true }),
    enable: async () => ({ ok: true }), disable: async () => ({ ok: true }),
    remove: async () => ({ ok: true }), adopt: async () => ({ ok: true, adopted: [] }),
    unadopt: async () => ({ ok: true }), list: async () => ({ items: [], generatedAt: 0 })
  } as unknown as IpcDeps['service'],
  runNow: async () => ({ status: 'ui_timeout', jobId: 1, waitedMs: 0 }),
  listRunsForJob: () => [],
  recentRuns: () => [],
  runNowStreaming: async () => {},
  cancelBatch: () => {},
  ...over
})

describe('handleJobsCreate validation', () => {
  it('rejects a non-string command without calling the service', async () => {
    let called = false
    const d = deps({ service: { ...deps().service, create: async () => { called = true; return { ok: true } } } })
    const r = await handleJobsCreate(d, { name: 'x', scheduleExpr: '0 3 * * *', command: 123 })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_input')
    expect(called).toBe(false)
  })
  it('rejects a scheduleExpr with an embedded newline (cron-line injection — code review #1)', async () => {
    const r = await handleJobsCreate(deps(), { name: 'x', scheduleExpr: '* * * * *\nevil * * * * *', command: '/b.sh' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_input')
  })
})

describe('handleJobsUpdate validation', () => {
  it('rejects a non-string scheduleExpr in changes (was a silent cast before — code review #1)', async () => {
    const r = await handleJobsUpdate(deps(), { id: 1, changes: { scheduleExpr: 42 } })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_input')
  })
  it('accepts a well-formed partial change', async () => {
    const r = await handleJobsUpdate(deps(), { id: 1, changes: { name: 'renamed' } })
    expect(r.ok).toBe(true)
  })
})

describe('handleJobsAdopt batch cap', () => {
  it(`rejects more than ${MAX_BATCH_ADOPT} items`, async () => {
    const items = Array.from({ length: MAX_BATCH_ADOPT + 1 }, () => ({ scheduleExpr: '0 3 * * *', command: '/b.sh' }))
    const r = await handleJobsAdopt(deps(), { items })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_input')
  })
})

describe('handleRunsRecent', () => {
  it('delegates to deps.recentRuns with default limit when payload limit is absent', () => {
    const rows = [{ id: 1 }]
    const d = deps({ recentRuns: () => rows as never[] })
    const result = handleRunsRecent(d, {})
    expect(result).toBe(rows)
  })
  it('passes a valid positive-integer limit through', () => {
    let got = 0
    const d = deps({ recentRuns: (limit) => { got = limit ?? -1; return [] } })
    handleRunsRecent(d, { limit: 10 })
    expect(got).toBe(10)
  })
  it(`caps limit at MAX_RUN_LIST_LIMIT (${MAX_RUN_LIST_LIMIT})`, () => {
    let got = 0
    const d = deps({ recentRuns: (limit) => { got = limit ?? -1; return [] } })
    handleRunsRecent(d, { limit: MAX_RUN_LIST_LIMIT + 9999 })
    expect(got).toBe(MAX_RUN_LIST_LIMIT)
  })
  it('ignores a non-positive or non-integer limit and uses repo default', () => {
    let got: number | undefined = -999
    const d = deps({ recentRuns: (limit) => { got = limit; return [] } })
    handleRunsRecent(d, { limit: -5 })
    expect(got).toBeUndefined()
  })
})

describe('Plan 6 IPC handlers', () => {
  it('runNowStreaming validates id then delegates', async () => {
    let got = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = { ...deps(), runNowStreaming: async (id: number) => { got = id } } as any
    await handleJobsRunNowStreaming(d, { id: 5 })
    expect(got).toBe(5)
  })
  it('runNowStreaming rejects invalid id', async () => {
    let called = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = { ...deps(), runNowStreaming: async () => { called = true } } as any
    await expect(handleJobsRunNowStreaming(d, { id: -1 })).rejects.toThrow('invalid id')
    expect(called).toBe(false)
  })
  it('cancelBatch delegates', () => {
    let called = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = { ...deps(), cancelBatch: () => { called = true } } as any
    handleJobsRunBatchCancel(d)
    expect(called).toBe(true)
  })
})

import { describe, it, expect, vi } from 'vitest'
import {
  handleGetVersion, handleJobsCreate, handleJobsUpdate, handleJobsAdopt, handleJobsRunNowStreaming, handleJobsRunBatchCancel, handleRunsRecent, handleNotifySave,
  handlePgTestConnection, handlePgSaveSwitch, handlePgGetStatus, handleDashboardSummary,
  MAX_BATCH_ADOPT, MAX_RUN_LIST_LIMIT, type IpcDeps
} from '../src/main/ipc'
import type { DashboardSummary } from '../src/shared/ipc-contract'
import { buildDsn, type PgDsnParts } from '../src/main/services/pg-dsn'

describe('handleGetVersion', () => {
  it('returns the app name and a semver-shaped version', () => {
    const result = handleGetVersion({ name: 'chronos-ui', version: '0.1.0' })
    expect(result.name).toBe('chronos-ui')
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

const fakeDashboardSummary: DashboardSummary = {
  runsToday: 0, succeededToday: 0, failedToday: 0, activeJobs: 0,
  failures: [], failuresTotal: 0, upcoming: [], generatedAt: 0
}

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
  pgTestConnection: async () => ({ ok: true, version: 'PostgreSQL 16.4', ms: 1 }),
  pgSwitchToPostgres: async () => ({ ok: true, needRelaunch: true }),
  pgSwitchToSqlite: async () => ({ ok: true, needRelaunch: true }),
  pgGetStatus: async () => ({ activeBackend: 'sqlite', keychainAvailable: true }),
  drainDb: async () => {},
  relaunchApp: () => {},
  exitApp: () => {},
  dashboardSummary: async () => fakeDashboardSummary,
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

describe('handleJobsCreate validation — carriage return (code review #10)', () => {
  it('rejects a command with an embedded carriage return (cron-line injection)', async () => {
    const r = await handleJobsCreate(deps(), { name: 'x', scheduleExpr: '* * * * *', command: '/b.sh\rinjected' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('invalid_input')
  })
})

describe('handleNotifySave validation — token / chatId format (code review #7)', () => {
  const notifyDeps = (track: { saved: boolean }): Partial<IpcDeps> => ({
    notify: {
      getSettings: async () => ({ enabled: false, chatId: null, windowMin: 0, tokenSet: false }),
      saveSettings: async () => { track.saved = true; return { ok: true } },
      testSend: async () => ({ ok: true })
    } as unknown as IpcDeps['notify']
  })

  it('rejects a malformed bot token (slash — path-injection vector) without saving', async () => {
    const track = { saved: false }
    const r = await handleNotifySave(deps(notifyDeps(track)), { enabled: true, chatId: '123', windowMin: 0, token: 'evil/../sendMessage' })
    expect(r.ok).toBe(false)
    expect(track.saved).toBe(false)
  })
  it('rejects a malformed chatId without saving', async () => {
    const track = { saved: false }
    const r = await handleNotifySave(deps(notifyDeps(track)), { enabled: true, chatId: 'not a chat', windowMin: 0, token: '123456789:ABCdef_-' })
    expect(r.ok).toBe(false)
    expect(track.saved).toBe(false)
  })
  it('accepts a well-formed token + numeric (group) chatId', async () => {
    const track = { saved: false }
    const r = await handleNotifySave(deps(notifyDeps(track)), { enabled: true, chatId: '-1001234567', windowMin: 0, token: '123456789:ABCdef_GHIjkl-mno' })
    expect(r.ok).toBe(true)
    expect(track.saved).toBe(true)
  })
  it('accepts an @channel chatId and an omitted token (no token change)', async () => {
    const track = { saved: false }
    const r = await handleNotifySave(deps(notifyDeps(track)), { enabled: true, chatId: '@mychannel', windowMin: 0 })
    expect(r.ok).toBe(true)
    expect(track.saved).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// T13 — pg settings UI IPC handlers (handlePgTestConnection / handlePgSaveSwitch).
// ---------------------------------------------------------------------------------------------
const validPgFields: PgDsnParts = { host: 'localhost', port: 5432, database: 'chronos', user: 'chronos', password: 'p@ss', sslmode: 'require' }

describe('handlePgTestConnection validation + delegation (T13)', () => {
  it('rejects an empty host without calling pgTestConnection', async () => {
    let called = false
    const d = deps({ pgTestConnection: async () => { called = true; return { ok: true, version: 'x', ms: 1 } } })
    const r = await handlePgTestConnection(d, { ...validPgFields, host: '' })
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
  it('rejects a non-integer / out-of-range / non-numeric port', async () => {
    expect((await handlePgTestConnection(deps(), { ...validPgFields, port: 0 })).ok).toBe(false)
    expect((await handlePgTestConnection(deps(), { ...validPgFields, port: 70000 })).ok).toBe(false)
    expect((await handlePgTestConnection(deps(), { ...validPgFields, port: 5432.5 })).ok).toBe(false)
    expect((await handlePgTestConnection(deps(), { ...validPgFields, port: '5432' })).ok).toBe(false)
  })
  it('rejects an unrecognized sslmode', async () => {
    const r = await handlePgTestConnection(deps(), { ...validPgFields, sslmode: 'yolo' })
    expect(r.ok).toBe(false)
  })
  it('rejects a missing/malformed payload entirely', async () => {
    expect((await handlePgTestConnection(deps(), null)).ok).toBe(false)
    expect((await handlePgTestConnection(deps(), 'not an object')).ok).toBe(false)
  })
  it('builds a DSN from well-formed fields and delegates to pgTestConnection', async () => {
    let gotDsn = ''
    const d = deps({ pgTestConnection: async (dsn) => { gotDsn = dsn; return { ok: true, version: 'PostgreSQL 16', ms: 3 } } })
    const r = await handlePgTestConnection(d, validPgFields)
    expect(r).toEqual({ ok: true, version: 'PostgreSQL 16', ms: 3 })
    expect(gotDsn).toBe(buildDsn(validPgFields))
  })
})

describe('handlePgSaveSwitch validation (T13)', () => {
  it('rejects an invalid targetBackend', async () => {
    const r = await handlePgSaveSwitch(deps(), { fields: validPgFields, copyData: false, targetBackend: 'mysql' })
    expect(r.ok).toBe(false)
  })
  it('rejects malformed fields when targetBackend=postgres', async () => {
    const r = await handlePgSaveSwitch(deps(), { fields: { ...validPgFields, host: '' }, copyData: false, targetBackend: 'postgres' })
    expect(r.ok).toBe(false)
  })
  it('rejects a non-boolean copyData', async () => {
    const r = await handlePgSaveSwitch(deps(), { fields: validPgFields, copyData: 'yes', targetBackend: 'postgres' })
    expect(r.ok).toBe(false)
  })
  it('ignores malformed fields when targetBackend=sqlite (fields are irrelevant to a switch-back)', async () => {
    let switched = false
    // activeBackend must differ from the sqlite target, or the I3 already-active guard rejects this
    // before ever reaching pgSwitchToSqlite (see the dedicated I3 describe block below).
    const d = deps({
      pgGetStatus: async () => ({ activeBackend: 'postgres', keychainAvailable: true }),
      pgSwitchToSqlite: async () => { switched = true; return { ok: true, needRelaunch: true } }
    })
    const r = await handlePgSaveSwitch(d, {
      fields: { host: '', port: -1, database: '', user: '', password: '', sslmode: 'nope' },
      copyData: false,
      targetBackend: 'sqlite'
    })
    expect(r).toEqual({ ok: true })
    expect(switched).toBe(true)
  })
  it('surfaces the switch step own error without wrapping it', async () => {
    const d = deps({ pgSwitchToPostgres: async () => ({ ok: false, error: 'target Postgres database already has rows in: jobs', stage: 'assertTargetEmpty' }) })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: true, targetBackend: 'postgres' })
    expect(r).toEqual({ ok: false, error: 'target Postgres database already has rows in: jobs' })
  })
})

describe('handlePgSaveSwitch — password never leaks (T13)', () => {
  it('a validation rejection never echoes the raw password', async () => {
    const secretPw = 'sUpEr$ecret123'
    const r = await handlePgSaveSwitch(deps(), { fields: { ...validPgFields, host: '', password: secretPw }, copyData: false, targetBackend: 'postgres' })
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(secretPw)
  })
  it('a failed switch error never echoes the raw password, and nothing is console-logged with it', async () => {
    const secretPw = 'sUpEr$ecret123'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = deps({ pgSwitchToPostgres: async () => ({ ok: false, error: 'connection refused', stage: 'testConnection' }) })
    const r = await handlePgSaveSwitch(d, { fields: { ...validPgFields, password: secretPw }, copyData: false, targetBackend: 'postgres' })
    expect(r).toEqual({ ok: false, error: 'connection refused' })
    expect(JSON.stringify(r)).not.toContain(secretPw)
    for (const call of [...errorSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain(secretPw)
    }
    errorSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore()
  })
})

describe('handlePgSaveSwitch — drain, then relaunch/exit after a successful switch (plan-advisor H2 / C2, T13)', () => {
  it('awaits drainDb, then calls relaunchApp then exitApp, after a successful postgres switch', async () => {
    const calls: string[] = []
    const d = deps({
      pgSwitchToPostgres: async () => ({ ok: true, needRelaunch: true }),
      drainDb: async () => { calls.push('drain') },
      relaunchApp: () => calls.push('relaunch'),
      exitApp: () => calls.push('exit')
    })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: true, targetBackend: 'postgres' })
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual(['drain', 'relaunch', 'exit'])
  })
  it('awaits drainDb, then calls relaunchApp then exitApp, after a successful sqlite switch', async () => {
    const calls: string[] = []
    // activeBackend must differ from the sqlite target here, or the I3 already-active guard
    // (below) rejects this as a no-op before ever reaching pgSwitchToSqlite/drainDb/relaunch/exit.
    const d = deps({
      pgGetStatus: async () => ({ activeBackend: 'postgres', keychainAvailable: true }),
      pgSwitchToSqlite: async () => ({ ok: true, needRelaunch: true }),
      drainDb: async () => { calls.push('drain') },
      relaunchApp: () => calls.push('relaunch'),
      exitApp: () => calls.push('exit')
    })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: false, targetBackend: 'sqlite' })
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual(['drain', 'relaunch', 'exit'])
  })
  it('does NOT drain / relaunch / exit when the switch fails', async () => {
    const calls: string[] = []
    const d = deps({
      pgSwitchToPostgres: async () => ({ ok: false, error: 'boom', stage: 'testConnection' }),
      drainDb: async () => { calls.push('drain') },
      relaunchApp: () => calls.push('relaunch'),
      exitApp: () => calls.push('exit')
    })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: false, targetBackend: 'postgres' })
    expect(r).toEqual({ ok: false, error: 'boom' })
    expect(calls).toEqual([])
  })
  it('does NOT drain / relaunch / exit when validation rejects before any switch attempt', async () => {
    const calls: string[] = []
    const d = deps({
      drainDb: async () => { calls.push('drain') },
      relaunchApp: () => calls.push('relaunch'),
      exitApp: () => calls.push('exit')
    })
    const r = await handlePgSaveSwitch(d, { fields: { ...validPgFields, host: '' }, copyData: false, targetBackend: 'postgres' })
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('handlePgSaveSwitch — rejects switching to the already-active backend (I3, T13)', () => {
  it('rejects targetBackend=postgres when postgres is already active, without calling pgSwitchToPostgres', async () => {
    let switched = false
    const d = deps({
      pgGetStatus: async () => ({ activeBackend: 'postgres', keychainAvailable: true }),
      pgSwitchToPostgres: async () => { switched = true; return { ok: true, needRelaunch: true } }
    })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: false, targetBackend: 'postgres' })
    expect(r).toEqual({ ok: false, error: 'Already using PostgreSQL backend' })
    expect(switched).toBe(false)
  })
  it('rejects targetBackend=sqlite when sqlite is already active, without calling pgSwitchToSqlite', async () => {
    let switched = false
    const d = deps({
      pgGetStatus: async () => ({ activeBackend: 'sqlite', keychainAvailable: true }),
      pgSwitchToSqlite: async () => { switched = true; return { ok: true, needRelaunch: true } }
    })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: false, targetBackend: 'sqlite' })
    expect(r).toEqual({ ok: false, error: 'Already using SQLite backend' })
    expect(switched).toBe(false)
  })
  it('does not relaunch/exit/drain when rejected as already-active', async () => {
    const calls: string[] = []
    const d = deps({
      pgGetStatus: async () => ({ activeBackend: 'postgres', keychainAvailable: true }),
      drainDb: async () => { calls.push('drain') },
      relaunchApp: () => calls.push('relaunch'),
      exitApp: () => calls.push('exit')
    })
    await handlePgSaveSwitch(d, { fields: validPgFields, copyData: false, targetBackend: 'postgres' })
    expect(calls).toEqual([])
  })
  it('a targetBackend that differs from the active backend still proceeds normally', async () => {
    const d = deps({ pgGetStatus: async () => ({ activeBackend: 'sqlite', keychainAvailable: true }) })
    const r = await handlePgSaveSwitch(d, { fields: validPgFields, copyData: true, targetBackend: 'postgres' })
    expect(r).toEqual({ ok: true })
  })
})

describe('handlePgGetStatus (T15)', () => {
  it('delegates straight to deps.pgGetStatus', async () => {
    const d = deps({ pgGetStatus: async () => ({ activeBackend: 'postgres', keychainAvailable: false }) })
    const r = await handlePgGetStatus(d)
    expect(r).toEqual({ activeBackend: 'postgres', keychainAvailable: false })
  })
})

describe('handleDashboardSummary (Task 5)', () => {
  it('delegates straight to deps.dashboardSummary', async () => {
    const summary: DashboardSummary = { ...fakeDashboardSummary, runsToday: 7, generatedAt: 12345 }
    const d = deps({ dashboardSummary: async () => summary })
    const r = await handleDashboardSummary(d)
    expect(r).toEqual(summary)
  })
})

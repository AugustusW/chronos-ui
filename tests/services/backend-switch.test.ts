// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  testConnection,
  rebakeDescriptors,
  switchToPostgres,
  switchToSqlite,
  maxRowId,
  PG_DSN_SERVICE,
  type PgClientLike,
  type RebakeDeps,
  type SwitchToPostgresDeps,
  type SwitchToSqliteDeps,
  type TestConnectionResult,
  type MigrateTargetResult,
  type CopyDataResult,
  type RebakeResult
} from '../../src/main/services/backend-switch'
import type { AdoptOptions, WriteResult } from '../../src/main/scheduler/types'
import type { Job } from '../../src/main/db/schema'
import { readBackendConfig } from '../../src/main/db/backendConfig'

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

// ---------------------------------------------------------------------------------------------
// maxRowId (C3, code review) — copyData's three setval() calls used to compute the max id via
// `Math.max(...rows.map(r => r.id))`; spreading a >~100k-element array as call arguments overflows
// V8's call-stack argument limit (a bare `Math.max(...Array.from({length:130000}))` throws
// "RangeError: Maximum call stack size exceeded" — reproduced standalone below, independent of
// copyData's DB plumbing, since run_logs alone easily exceeds 100k rows at the default 90-day
// retention). maxRowId replaces the spread with a plain reduce, which has no such ceiling.
// ---------------------------------------------------------------------------------------------
describe('maxRowId (C3, copyData sequence fix-up helper)', () => {
  it('demonstrates the Math.max(...spread) pattern it replaces overflows the call stack at scale', () => {
    const rows = Array.from({ length: 130_000 }, (_, i) => ({ id: i + 1 }))
    expect(() => Math.max(...rows.map((r) => r.id))).toThrow(RangeError)
  })

  it('computes the max id for a 130k-row array without throwing', () => {
    const rows = Array.from({ length: 130_000 }, (_, i) => ({ id: i + 1 }))
    expect(maxRowId(rows)).toBe(130_000)
  })

  it('returns 0 for an empty array (mirrors the guarded call sites, which only run when rows.length > 0)', () => {
    expect(maxRowId([])).toBe(0)
  })

  it('does not assume ascending input order', () => {
    expect(maxRowId([{ id: 5 }, { id: 130_000 }, { id: 1 }])).toBe(130_000)
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

// ---------------------------------------------------------------------------------------------
// switchToPostgres (T8) — every step is dependency-injected (defaults to the real implementations
// exported above, per SwitchToPostgresDeps), so the orchestration (call order, early-exit stage,
// cleanup-on-failure) is fully testable here with no DB and no filesystem beyond a throwaway
// backendConfig.json directory (mirrors backendConfig.test.ts's own mkdtempSync convention).
// ---------------------------------------------------------------------------------------------
describe('switchToPostgres (T8, mocked steps)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-bswitch-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const configApp = () => ({ getPath: () => dir })
  const OK_TEST: TestConnectionResult = { ok: true, version: 'PostgreSQL 16', ms: 5 }
  const OK_MIGRATE: MigrateTargetResult = { ok: true }
  const OK_COPY: CopyDataResult = { ok: true, counts: { jobs: 1, runLogs: 2, notifySettings: 1, notifyOutbox: 0 } }
  const OK_REBAKE: RebakeResult = { ok: true, rebaked: [1], errors: [] }

  function baseDeps(over: Partial<SwitchToPostgresDeps> = {}): SwitchToPostgresDeps {
    const { adapter } = fakeRebakeAdapter()
    return {
      sqliteHandle: {} as never, // never touched unless copyData/jobs.list are NOT overridden — every scenario below overrides them
      migrationsPgPath: '/migrations/pg',
      secretDeps: { exec: vi.fn(async () => ({ code: 1, stdout: '' })), platform: 'win32', configDir: dir },
      configApp: configApp(),
      sqlitePath: '/db/chronos.db',
      rebake: { adapter, schedmgrPath: '/opt/schedmgr' },
      loadJobs: async () => [],
      testConnection: vi.fn(async () => OK_TEST),
      migrateTarget: vi.fn(async () => OK_MIGRATE),
      assertTargetEmpty: vi.fn(async () => undefined),
      copyData: vi.fn(async () => OK_COPY),
      pgSecretStore: vi.fn(async () => undefined),
      pgSecretDelete: vi.fn(async () => undefined),
      rebakeDescriptors: vi.fn(async () => OK_REBAKE),
      truncateTarget: vi.fn(async () => undefined),
      ...over
    }
  }

  it('happy path with copy: runs every step in order and writes the postgres backendConfig', async () => {
    const deps = baseDeps()
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res).toEqual({ ok: true, needRelaunch: true })
    expect(deps.testConnection).toHaveBeenCalledWith('postgresql://u:p@h/db')
    expect(deps.migrateTarget).toHaveBeenCalledWith('postgresql://u:p@h/db', '/migrations/pg')
    expect(deps.assertTargetEmpty).toHaveBeenCalledWith('postgresql://u:p@h/db')
    expect(deps.copyData).toHaveBeenCalledOnce()
    expect(deps.pgSecretStore).toHaveBeenCalledWith(PG_DSN_SERVICE, 'postgresql://u:p@h/db', deps.secretDeps)
    expect(deps.rebakeDescriptors).toHaveBeenCalledWith(
      { backend: 'postgres', pgService: PG_DSN_SERVICE },
      '/db/chronos.db',
      [],
      deps.rebake
    )
    expect(readBackendConfig(configApp())).toEqual({ backend: 'postgres', pgService: PG_DSN_SERVICE })
    expect(deps.truncateTarget).not.toHaveBeenCalled()
    expect(deps.pgSecretDelete).not.toHaveBeenCalled() // happy path never deletes what it just stored
  })

  it('copy:false skips copyData entirely but still finalizes', async () => {
    const deps = baseDeps()
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: false }, deps)
    expect(res).toEqual({ ok: true, needRelaunch: true })
    expect(deps.copyData).not.toHaveBeenCalled()
    expect(deps.pgSecretStore).toHaveBeenCalledOnce()
  })

  it('a custom pgService overrides PG_DSN_SERVICE end-to-end', async () => {
    const deps = baseDeps()
    await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: false, pgService: 'custom/svc' }, deps)
    expect(deps.pgSecretStore).toHaveBeenCalledWith('custom/svc', 'postgresql://u:p@h/db', deps.secretDeps)
    expect(readBackendConfig(configApp())).toEqual({ backend: 'postgres', pgService: 'custom/svc' })
  })

  it('aborts at testConnection without calling any later step', async () => {
    const deps = baseDeps({ testConnection: vi.fn(async () => ({ ok: false, error: 'refused' })) })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res).toEqual({ ok: false, error: 'refused', stage: 'testConnection' })
    expect(deps.migrateTarget).not.toHaveBeenCalled()
    expect(deps.copyData).not.toHaveBeenCalled()
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' }) // untouched (default)
  })

  it('aborts at migrateTarget without calling assertTargetEmpty/copyData/finalize', async () => {
    const deps = baseDeps({ migrateTarget: vi.fn(async () => ({ ok: false, error: 'migration failed' })) })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res).toEqual({ ok: false, error: 'migration failed', stage: 'migrateTarget' })
    expect(deps.assertTargetEmpty).not.toHaveBeenCalled()
    expect(deps.copyData).not.toHaveBeenCalled()
  })

  it('aborts at assertTargetEmpty (TargetNotEmptyError) without calling copyData/finalize', async () => {
    const deps = baseDeps({ assertTargetEmpty: vi.fn(async () => { throw new Error('target Postgres database already has rows in: jobs') }) })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res).toEqual({ ok: false, error: 'target Postgres database already has rows in: jobs', stage: 'assertTargetEmpty' })
    expect(deps.copyData).not.toHaveBeenCalled()
    expect(deps.pgSecretStore).not.toHaveBeenCalled()
  })

  it('I1: redacts a raw DSN embedded in an assertTargetEmpty-stage driver error before returning it', async () => {
    const dsn = 'postgresql://u:SECRET@h/db'
    const deps = baseDeps({
      assertTargetEmpty: vi.fn(async () => { throw new Error(`invalid connection string: ${dsn}`) })
    })
    const res = await switchToPostgres({ dsn, copy: true }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stage).toBe('assertTargetEmpty')
      expect(res.error).not.toContain('SECRET')
      expect(res.error).toContain('***')
    }
  })

  it('aborts at copyData without any cleanup (nothing was ever committed — the copy transaction itself rolled back)', async () => {
    const deps = baseDeps({ copyData: vi.fn(async () => { throw new Error('count mismatch') }) })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res).toEqual({ ok: false, error: 'count mismatch', stage: 'copyData' })
    expect(deps.pgSecretStore).not.toHaveBeenCalled()
    expect(deps.truncateTarget).not.toHaveBeenCalled() // nothing to clean up — copy itself already rolled back
  })

  it('I1: redacts a raw DSN embedded in a copyData-stage driver error before returning it', async () => {
    const dsn = 'postgresql://u:SECRET@h/db'
    const deps = baseDeps({
      copyData: vi.fn(async () => { throw new Error(`invalid connection string: ${dsn}`) })
    })
    const res = await switchToPostgres({ dsn, copy: true }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stage).toBe('copyData')
      expect(res.error).not.toContain('SECRET')
      expect(res.error).toContain('***')
    }
  })

  it('cleanup-on-failure: pgSecretStore fails AFTER a successful copy — reverts config to sqlite, re-bakes to sqlite, deletes the credential, truncates the target', async () => {
    const deps = baseDeps({
      pgSecretStore: vi.fn(async () => { throw new Error('keychain + fallback file both failed') })
    })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res).toEqual({ ok: false, error: 'keychain + fallback file both failed', stage: 'finalize' })
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })
    expect(deps.rebakeDescriptors).toHaveBeenCalledWith({ backend: 'sqlite' }, '/db/chronos.db', [], deps.rebake)
    expect(deps.truncateTarget).toHaveBeenCalledWith('postgresql://u:p@h/db')
    // I2: pgSecretStore itself threw here (never actually wrote anything), but the cleanup branch
    // still attempts the delete unconditionally — pgSecretDelete is a safe no-op against a
    // never-written credential (pg-secret.ts: it never throws), so there is no reason to gate it on
    // whether the store call happened to get that far.
    expect(deps.pgSecretDelete).toHaveBeenCalledWith(PG_DSN_SERVICE, deps.secretDeps)
  })

  it('I1: redacts a raw DSN embedded in a finalize-stage driver error (pgSecretStore) before returning it', async () => {
    const dsn = 'postgresql://u:SECRET@h/db'
    const deps = baseDeps({
      pgSecretStore: vi.fn(async () => { throw new Error(`invalid connection string: ${dsn}`) })
    })
    const res = await switchToPostgres({ dsn, copy: true }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stage).toBe('finalize')
      expect(res.error).not.toContain('SECRET')
      expect(res.error).toContain('***')
    }
  })

  it('cleanup-on-failure: rebakeDescriptors reports errors AFTER a successful copy — same cleanup path (incl. credential delete)', async () => {
    const deps = baseDeps({
      rebakeDescriptors: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, rebaked: [], errors: [{ id: 1, error: 'no matching unadopted line' }] })
        .mockResolvedValueOnce(OK_REBAKE) // the cleanup path's own re-bake-to-sqlite call
    })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stage).toBe('finalize')
      expect(res.error).toContain('no matching unadopted line')
    }
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })
    expect(deps.truncateTarget).toHaveBeenCalledOnce()
    // I2: pgSecretStore DID succeed here before rebakeDescriptors failed — the just-stored credential
    // must not be left orphaned in the keychain once the switch reverts to sqlite.
    expect(deps.pgSecretDelete).toHaveBeenCalledWith(PG_DSN_SERVICE, deps.secretDeps)
  })

  it('C1: copy:false — truncateTarget never runs (nothing was copied), but config/rebake/secret-delete cleanup still does', async () => {
    const deps = baseDeps({
      pgSecretStore: vi.fn(async () => { throw new Error('boom') })
    })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: false }, deps)
    expect(res).toEqual({ ok: false, error: 'boom', stage: 'finalize' })
    // truncateTarget is still correctly gated on `copied` — copy:false never wrote real rows into
    // the target, so there's nothing there to wipe.
    expect(deps.truncateTarget).not.toHaveBeenCalled()
    // But the rest of the cleanup branch is now UNCONDITIONAL (C1): before this fix, `copied` stays
    // false for copy:false, so the entire `if (copied) {...}` block — including the config/rebake
    // revert — was skipped, even though pgSecretStore is called (and here, fails) exactly the same
    // way regardless of `config.copy`. Without the fix, deps.rebakeDescriptors below would never be
    // invoked at all for this scenario.
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })
    expect(deps.rebakeDescriptors).toHaveBeenCalledWith({ backend: 'sqlite' }, '/db/chronos.db', [], deps.rebake)
    expect(deps.pgSecretDelete).toHaveBeenCalledWith(PG_DSN_SERVICE, deps.secretDeps)
  })

  it('C1: copy:false + rebakeDescriptors fails AFTER writeBackendConfig(postgres) already committed — config must still revert to sqlite, not strand on postgres', async () => {
    const deps = baseDeps({
      rebakeDescriptors: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, rebaked: [], errors: [{ id: 1, error: 'no matching unadopted line' }] })
        .mockResolvedValueOnce(OK_REBAKE) // the cleanup path's own re-bake-to-sqlite call
    })
    const res = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: false }, deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stage).toBe('finalize')
      expect(res.error).toContain('no matching unadopted line')
    }
    // The real bug this test pins down: writeBackendConfig(postgres) DID commit for real here (it
    // runs unconditionally, before the rebake call that then fails) — a copy:false switch reaching
    // this point without the C1 fix would leave backendConfig.json on 'postgres' (and the native
    // cron lines half-rebaked) while reporting ok:false, because `copied` stayed false the whole
    // time and gated OFF the only cleanup that would have reverted it.
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })
    expect(deps.rebakeDescriptors).toHaveBeenLastCalledWith({ backend: 'sqlite' }, '/db/chronos.db', [], deps.rebake)
    expect(deps.truncateTarget).not.toHaveBeenCalled()
    expect(deps.pgSecretDelete).toHaveBeenCalledWith(PG_DSN_SERVICE, deps.secretDeps)
  })

  it('retry after cleanup succeeds: a mid-fail then a second call with the same (now-working) deps completes', async () => {
    let calls = 0
    const deps = baseDeps({
      pgSecretStore: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('transient keychain error')
      })
    })
    const first = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(first.ok).toBe(false)
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })

    const second = await switchToPostgres({ dsn: 'postgresql://u:p@h/db', copy: true }, deps)
    expect(second).toEqual({ ok: true, needRelaunch: true })
    expect(readBackendConfig(configApp())).toEqual({ backend: 'postgres', pgService: PG_DSN_SERVICE })
  })
})

// ---------------------------------------------------------------------------------------------
// switchToSqlite (T9) — the reverse of switchToPostgres, but much simpler: it never touches the
// Postgres target at all (spec: "不動 PG 資料") — just flips backendConfig.json back to sqlite and
// re-bakes every adopted job's --db back to the plain sqlite file path.
// ---------------------------------------------------------------------------------------------
describe('switchToSqlite (T9, mocked steps)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-bswitch-sqlite-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const configApp = () => ({ getPath: () => dir })

  function baseDeps(over: Partial<SwitchToSqliteDeps> = {}): SwitchToSqliteDeps {
    const { adapter } = fakeRebakeAdapter()
    return {
      sqliteHandle: {} as never, // unused unless loadJobs is NOT overridden
      configApp: configApp(),
      sqlitePath: '/db/chronos.db',
      rebake: { adapter, schedmgrPath: '/opt/schedmgr' },
      loadJobs: async () => [],
      rebakeDescriptors: vi.fn(async () => ({ ok: true, rebaked: [], errors: [] }) as RebakeResult),
      ...over
    }
  }

  it('writes the sqlite backendConfig and re-bakes every adopted job back to the plain file path', async () => {
    // A single shared fixture object (not two separate `job(...)` calls) — `job()` stamps
    // createdAt/updatedAt with `new Date()` on each call, and two independently-constructed Date
    // objects can land in different milliseconds, which previously made this assertion flaky.
    const j = job({ id: 1, scheduleExpr: '* * * * *', command: '/x.sh', adopted: true })
    const deps = baseDeps({ loadJobs: async () => [j] })
    const res = await switchToSqlite(deps)
    expect(res).toEqual({ ok: true, needRelaunch: true })
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })
    expect(deps.rebakeDescriptors).toHaveBeenCalledWith({ backend: 'sqlite' }, '/db/chronos.db', [j], deps.rebake)
  })

  it('surfaces a rebake failure without throwing (config is already correctly sqlite either way)', async () => {
    const deps = baseDeps({
      rebakeDescriptors: vi.fn(async () => ({ ok: false, rebaked: [], errors: [{ id: 1, error: 'no matching unadopted line' }] }))
    })
    const res = await switchToSqlite(deps)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.stage).toBe('rebake')
      expect(res.error).toContain('no matching unadopted line')
    }
    expect(readBackendConfig(configApp())).toEqual({ backend: 'sqlite' })
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { buildMainDeps, BootPgUnreachableError, handleBootPgUnreachable, BOOT_PG_UNREACHABLE_BUTTONS, type BuiltDeps } from '../src/main/bootstrap'
import { openAndMigrate as openSqliteForTest } from '../src/main/db/lifecycle'
import { createSqliteNotifySettingsRepo } from '../src/main/db/notifySettings.repository'
import { LAUNCHD_FLUSH_LABEL } from '../src/main/services/notify-flush-launchd'
import { readBackendConfig } from '../src/main/db/backendConfig'
import type { DatabaseHandle } from '../src/main/db/client'
import type { PgSecretDeps } from '../src/main/services/pg-secret'
import type { ExecFn } from '../src/main/scheduler'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// The real project root (this test lives at chronos-ui/tests/), so the :memory: branch finds
// the real src/main/db/migrations folder.
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const fakeApp = {
  getName: () => 'chronos-ui', getVersion: () => '0.1.0', isPackaged: false,
  getPath: () => '/tmp/chronos-test-userdata', getAppPath: () => APP_ROOT
}
const exec: ExecFn = async () => ({ stdout: '', exitCode: 0 })

/** A genuinely-working sqlite handle (real migrations applied), for tests that only care about
 *  backend-config-driven WIRING (schedmgr descriptor, IPC assembly) — not about proving the boot-
 *  time postgres open itself works, which is the T11 describe block below's job. Faking `dialect:
 *  'postgres'` on a stub object would break jobs.service (adopt/create do real repo writes), so
 *  these fakes hand back a real, working handle instead. */
function fakeSqliteHandleForPgConfig(): Promise<DatabaseHandle> {
  return openSqliteForTest(
    { dialect: 'sqlite', path: ':memory:' },
    { sqlite: join(APP_ROOT, 'src/main/db/migrations'), pg: join(APP_ROOT, 'src/main/db/migrations.pg') }
  )
}

/** A structurally-valid (but never actually opened) postgres handle for T11/T12 tests that only
 *  assert on `dialect` / close() plumbing, never on real query behavior. */
function fakePgHandle(): DatabaseHandle {
  return { dialect: 'postgres', db: {} as never, checkpoint: () => {}, close: async () => {} }
}

describe('buildMainDeps', () => {
  it('assembles a complete IpcDeps from an injected app + exec (no real Electron)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(built.deps.meta).toEqual({ name: 'chronos-ui', version: '0.1.0' })
    expect(typeof built.deps.runNow).toBe('function')
    expect(typeof built.deps.listRunsForJob).toBe('function')
    expect(typeof built.deps.service.list).toBe('function')
    expect(built.schedmgrDescriptor).toBe(':memory:') // default config = sqlite → descriptor == dbPath
    await built.handle.close()
  })
  it('exposes the Plan 6 streaming deps (emit + runNowStreaming + cancelBatch + dbPath)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(typeof built.deps.runNowStreaming).toBe('function')
    expect(typeof built.deps.cancelBatch).toBe('function')
    expect(typeof built.emit).toBe('function')
    expect(built.dbPath).toBe(':memory:')
    await built.handle.close()
  })
  it('v0.4.0: built.emit fans every RunEvent out to BOTH the renderer webContents sink and the optional onRunEvent hook (index.ts wires the tray here)', async () => {
    const send = vi.fn()
    const onRunEvent = vi.fn()
    const built = await buildMainDeps(fakeApp, {
      exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:',
      getWebContents: () => ({ isDestroyed: () => false, send }) as never,
      onRunEvent
    })
    built.emit({ kind: 'jobsChanged' })
    expect(send).toHaveBeenCalledWith('run:event', { kind: 'jobsChanged' })
    expect(onRunEvent).toHaveBeenCalledWith({ kind: 'jobsChanged' })
    await built.handle.close()
  })
  it('onRunEvent is optional — omitting it leaves the renderer sink working as before', async () => {
    const send = vi.fn()
    const built = await buildMainDeps(fakeApp, {
      exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:',
      getWebContents: () => ({ isDestroyed: () => false, send }) as never
    })
    expect(() => built.emit({ kind: 'jobsChanged' })).not.toThrow()
    expect(send).toHaveBeenCalledWith('run:event', { kind: 'jobsChanged' })
    await built.handle.close()
  })
  it('v0.4.0: exposes listRunOutcomesSince, wired to the active dialect\'s dashboard repo (native-notify.service.ts\'s poll query)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(typeof built.listRunOutcomesSince).toBe('function')
    // No fixtures inserted — just proves the wiring round-trips to a real (empty) result, not a stub.
    expect(await built.listRunOutcomesSince(new Date(0), 10)).toEqual([])
    await built.handle.close()
  })
  it('v0.4.0: deps.searchRuns / deps.jobRunDurationTrend / deps.jobIo round-trip to the real repo layer (not stubs)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(await built.deps.searchRuns({ limit: 10 })).toEqual([])
    expect(await built.deps.jobRunDurationTrend(1)).toEqual([])
    // jobIo.exportJobs with the default (no dialog injected) stub dialog — proves the "always
    // canceled" BuildOpts default actually reaches the service, not just that jobIo exists.
    expect(await built.deps.jobIo.exportJobs()).toEqual({ status: 'error', error: 'No jobs to export' })
    await built.handle.close()
  })
  it('v0.4.0: injected showSaveDialog/showOpenDialog/readFile/writeFile reach job-io.service.ts', async () => {
    let wrote: { path?: string; content?: string } = {}
    const built = await buildMainDeps(fakeApp, {
      exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:',
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/x.yaml' }),
      writeFile: (p, c) => { wrote = { path: p, content: c } }
    })
    await built.deps.service.create({ name: 'A', scheduleExpr: '* * * * *', command: 'echo hi' })
    const r = await built.deps.jobIo.exportJobs()
    expect(r).toEqual({ status: 'ok', path: '/tmp/x.yaml' })
    expect(wrote.path).toBe('/tmp/x.yaml')
    expect(wrote.content).toContain('name: A')
    await built.handle.close()
  })
})

describe('buildMainDeps schedmgr descriptor (postgres backend config)', () => {
  it('computes + bakes the pg:keychain descriptor into the cron line (not the sqlite path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-'))
    writeFileSync(
      join(dir, 'chronos-config.json'),
      JSON.stringify({ backend: 'postgres', pgService: 'com.augustusw.chronos-ui/pg-dsn' })
    )
    let crontabWritten = ''
    // The schedmgr `--db` wrap is produced by adopt/adoptMany (which wrap an existing unmanaged
    // line). Return that unmanaged line on `crontab -l`; capture the wrapped write on `crontab -`.
    const capExec: ExecFn = async (cmd, args, stdin) => {
      if (cmd === 'crontab' && args[0] === '-l') return { stdout: '0 3 * * * /b.sh\n', exitCode: 0 }
      if (cmd === 'crontab' && args[0] === '-' && stdin) crontabWritten = stdin
      return { stdout: '', exitCode: 0 }
    }
    const pgApp = { ...fakeApp, getPath: () => dir }
    // T11: boot now actually opens postgres per the config — pgSecretRead/openAndMigrate are faked
    // (a real working sqlite handle underneath, see fakeSqliteHandleForPgConfig) so this test stays
    // about schedmgr descriptor computation / crontab baking, not the postgres open path itself
    // (covered by the dedicated 'buildMainDeps postgres backend boot (T11)' describe block below).
    const built = await buildMainDeps(pgApp, {
      exec: capExec,
      platform: 'darwin',
      appRoot: APP_ROOT,
      resourcesPath: '/x',
      dbPath: ':memory:',
      pgSecretRead: async () => 'postgresql://unused/for-this-test',
      openAndMigrate: fakeSqliteHandleForPgConfig
    })
    expect(built.schedmgrDescriptor).toBe('pg:keychain:com.augustusw.chronos-ui/pg-dsn')

    // Adopting the unmanaged line bakes the descriptor (the non-secret keychain reference) — NOT the
    // sqlite path, and NOT the DSN — into the schedmgr-wrapped crontab line.
    await built.deps.service.adopt([{ scheduleExpr: '0 3 * * *', command: '/b.sh' }])
    // The --db descriptor is shell-quoted in the crontab line (fix #1353), so assert the quoted form.
    expect(crontabWritten).toContain("--db 'pg:keychain:com.augustusw.chronos-ui/pg-dsn'")
    expect(crontabWritten).not.toContain('chronos.db')

    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('threads the descriptor into the runNow schedmgr argv (a runner path, not just the adapter)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc' }))
    let gotArgs: string[] = []
    const spawn = (_c: string, args: string[]): never => {
      gotArgs = args
      const ee = new EventEmitter()
      queueMicrotask(() => ee.emit('exit', 0))
      return ee as never
    }
    const pgApp = { ...fakeApp, getPath: () => dir }
    const built = await buildMainDeps(pgApp, {
      exec,
      platform: 'darwin',
      appRoot: APP_ROOT,
      resourcesPath: '/x',
      dbPath: ':memory:',
      spawn,
      pgSecretRead: async () => 'postgresql://unused/for-this-test',
      openAndMigrate: fakeSqliteHandleForPgConfig
    })
    const created = await built.deps.service.create({ name: 'X', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    const jobId = (created as { job?: { id: number } }).job!.id
    await built.deps.runNow(jobId)
    const i = gotArgs.indexOf('--db')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(gotArgs[i + 1]).toBe('pg:keychain:svc') // runner bakes the descriptor, not the sqlite path
    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------------------------
// T11 — buildMainDeps actually branches the GUI's OWN db-open on the persisted backend config
// (previously boot was always sqlite regardless of config — see the superseded comment on the
// describe block above). A connection failure (or a missing DSN) must throw a typed
// BootPgUnreachableError rather than silently falling back to sqlite (index.ts's T12 dialog is the
// only sanctioned fallback path, and it is explicit/user-driven).
// ---------------------------------------------------------------------------------------------
describe('buildMainDeps postgres backend boot (T11)', () => {
  it('opens sqlite when there is no backend config (readBackendConfig default)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(built.handle.dialect).toBe('sqlite')
    await built.handle.close()
  })

  it('opens postgres via pgSecretRead + openAndMigrate when the config says postgres', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-t11-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc-x' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    let gotService = ''
    let gotDeps: PgSecretDeps | undefined
    const pgSecretRead = vi.fn(async (service: string, deps: PgSecretDeps) => {
      gotService = service
      gotDeps = deps
      return 'postgresql://u:p@h/db'
    })
    let gotConfig: unknown
    const openAndMigrate = vi.fn(async (config: unknown) => {
      gotConfig = config
      return fakePgHandle()
    })
    const built = await buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', pgSecretRead, openAndMigrate })
    expect(built.handle.dialect).toBe('postgres')
    expect(gotService).toBe('svc-x')
    expect(gotDeps?.platform).toBe('darwin')
    expect(typeof gotDeps?.exec).toBe('function')
    expect(gotConfig).toEqual({ dialect: 'postgres', dsn: 'postgresql://u:p@h/db' })
    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws BootPgUnreachableError when no DSN is found for the configured service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-t11-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc-missing' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    const pgSecretRead = vi.fn(async () => null)
    await expect(
      buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', pgSecretRead })
    ).rejects.toBeInstanceOf(BootPgUnreachableError)
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws BootPgUnreachableError when backend=postgres but pgService is missing (malformed config)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-t11-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    await expect(
      buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x' })
    ).rejects.toBeInstanceOf(BootPgUnreachableError)
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws BootPgUnreachableError with a redacted message when the connection itself fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-t11-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc-y' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    const dsn = 'postgresql://u:SECRET@h/db'
    const pgSecretRead = vi.fn(async () => dsn)
    const openAndMigrate = vi.fn(async () => {
      throw new Error(`invalid connection string: ${dsn}`)
    })
    let caught: unknown
    try {
      await buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', pgSecretRead, openAndMigrate })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BootPgUnreachableError)
    const message = (caught as Error).message
    expect(message).not.toContain('SECRET')
    expect(message).toContain('***')
    rmSync(dir, { recursive: true, force: true })
  })

  it('forceSqlite bypasses a postgres backend config for a session-only fallback (never touches chronos-config.json)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-t11-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc-z' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    const pgSecretRead = vi.fn(async () => 'postgresql://should/not-be-used')
    const built = await buildMainDeps(pgApp, {
      exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:', pgSecretRead, forceSqlite: true
    })
    expect(built.handle.dialect).toBe('sqlite')
    expect(pgSecretRead).not.toHaveBeenCalled()
    expect(readBackendConfig(pgApp)).toEqual({ backend: 'postgres', pgService: 'svc-z' })
    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------------------------
// T15 — pgGetStatus wiring: the settings-UI status read (activeBackend + keychainAvailable) is
// derived straight from the SAME `cfg`/`platform` buildMainDeps already computes for boot (no
// separate re-read of chronos-config.json at call time — the settings UI reflects whatever backend
// THIS running process booted against, matching the "restart to apply" model the save/switch flow
// already uses elsewhere in this bolt).
// ---------------------------------------------------------------------------------------------
describe('buildMainDeps pgGetStatus wiring (T15)', () => {
  it('reports the sqlite default + keychain availability for a keychain-capable platform', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    await expect(built.deps.pgGetStatus()).resolves.toEqual({ activeBackend: 'sqlite', keychainAvailable: true })
    await built.handle.close()
  })

  it('reports postgres as the active backend once the config says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-t15-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc-status' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    const pgSecretRead = vi.fn(async () => 'postgresql://u:p@h/db')
    const openAndMigrate = vi.fn(async () => fakePgHandle())
    const built = await buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', pgSecretRead, openAndMigrate })
    await expect(built.deps.pgGetStatus()).resolves.toEqual({ activeBackend: 'postgres', keychainAvailable: true })
    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports keychainAvailable=false on a platform with no keychain write support (win32)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'win32', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    await expect(built.deps.pgGetStatus()).resolves.toEqual({ activeBackend: 'sqlite', keychainAvailable: false })
    await built.handle.close()
  })
})

// ---------------------------------------------------------------------------------------------
// C2 (code review) — IpcDeps.drainDb: ipc.ts's handlePgSaveSwitch awaits this before calling
// relaunchApp()/exitApp() after a successful backend switch, since electron's app.exit() never
// fires 'before-quit' (the only place index.ts's own pgQuitDrain teardown runs). Wired here to the
// SAME `handle` this boot already opened — draining it for real on a postgres boot, doing nothing
// on a sqlite boot (sqlite's close() is synchronous internally; nothing to await-drain).
// ---------------------------------------------------------------------------------------------
describe('buildMainDeps drainDb wiring (C2)', () => {
  it('is a no-op for a sqlite boot — never calls handle.close()', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    const closeSpy = vi.fn(built.handle.close.bind(built.handle))
    built.handle.close = closeSpy
    await built.deps.drainDb()
    expect(closeSpy).not.toHaveBeenCalled()
    await built.handle.close()
  })

  it('drains (awaits close()) the live postgres handle for a postgres boot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-c2-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc-drain' }))
    const pgApp = { ...fakeApp, getPath: () => dir }
    const pgSecretRead = vi.fn(async () => 'postgresql://u:p@h/db')
    const closeSpy = vi.fn(async () => {})
    const openAndMigrate = vi.fn(async () => ({ ...fakePgHandle(), close: closeSpy }))
    const built = await buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', pgSecretRead, openAndMigrate })
    await built.deps.drainDb()
    expect(closeSpy).toHaveBeenCalledOnce()
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------------------------
// T12 — index.ts's catch handler for a BootPgUnreachableError: a blocking "Database unreachable"
// dialog offering a session-only sqlite fallback or quitting outright. handleBootPgUnreachable is
// the pure, Electron-free decision function index.ts wires dialog.showMessageBox/app.quit into.
// ---------------------------------------------------------------------------------------------
describe('handleBootPgUnreachable (T12)', () => {
  const err = new BootPgUnreachableError('No DSN found in the keychain for service "svc-x".')

  it('shows the Database-unreachable dialog with the two spec buttons', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const quit = vi.fn()
    const buildSqliteFallback = vi.fn(async () => ({}) as BuiltDeps)
    await handleBootPgUnreachable(err, { showMessageBox, quit, buildSqliteFallback })
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        message: 'Database unreachable',
        detail: err.message,
        buttons: [...BOOT_PG_UNREACHABLE_BUTTONS]
      })
    )
  })

  it('resolves a session-only sqlite fallback BuiltDeps when the user picks "Start with SQLite"', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 0 }))
    const quit = vi.fn()
    const fallback = {} as BuiltDeps
    const buildSqliteFallback = vi.fn(async () => fallback)
    const result = await handleBootPgUnreachable(err, { showMessageBox, quit, buildSqliteFallback })
    expect(result).toBe(fallback)
    expect(quit).not.toHaveBeenCalled()
  })

  it('calls quit() and resolves null when the user picks "Quit" (or dismisses the dialog)', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const quit = vi.fn()
    const buildSqliteFallback = vi.fn(async () => ({}) as BuiltDeps)
    const result = await handleBootPgUnreachable(err, { showMessageBox, quit, buildSqliteFallback })
    expect(result).toBeNull()
    expect(quit).toHaveBeenCalledOnce()
    expect(buildSqliteFallback).not.toHaveBeenCalled()
  })
})

describe('boot-time notify-flush agent refresh (macOS)', () => {
  // Shape written by 0.2.0: schedmgr invoked directly, no /bin/sh wrapper. install() only ever runs
  // on a settings save, so without a boot-time refresh this file outlives every upgrade — and the
  // self-clean added for teardown never reaches the installs it exists to protect.
  const LEGACY = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_FLUSH_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/opt/schedmgr</string><string>notify-flush</string></array>
  <key>StartInterval</key><integer>600</integer>
</dict>
</plist>
`

  async function seed(notifyEnabled: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-launchagents-'))
    const dbFile = join(dir, 'chronos.db')
    const h = await openSqliteForTest(
      { dialect: 'sqlite', path: dbFile },
      { sqlite: join(APP_ROOT, 'src/main/db/migrations'), pg: join(APP_ROOT, 'src/main/db/migrations.pg') }
    )
    await createSqliteNotifySettingsRepo(h.db).save({
      enabled: notifyEnabled, chatId: '1', windowMin: 10, includeStderr: false, nativeEnabled: true
    })
    await h.close()

    const laDir = join(dir, 'LaunchAgents')
    mkdirSync(laDir)
    const plist = join(laDir, `${LAUNCHD_FLUSH_LABEL}.plist`)
    writeFileSync(plist, LEGACY)
    return { dir, dbFile, laDir, plist }
  }

  it('rewrites an agent left behind by an older build', async () => {
    const s = await seed(true)
    const built = await buildMainDeps(fakeApp, {
      exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x',
      dbPath: s.dbFile, launchAgentsDir: s.laDir
    })
    // The unit tests prove refreshIfStale is correct; this proves boot actually calls it. Deleting
    // the bootstrap call leaves those unit tests green and the bug fully restored.
    expect(readFileSync(s.plist, 'utf8')).toContain('<string>/bin/sh</string>')
    await built.handle.close()
    rmSync(s.dir, { recursive: true, force: true })
  })

  it('leaves it alone when notifications are off — refreshing would revive a disabled entry', async () => {
    const s = await seed(false)
    const built = await buildMainDeps(fakeApp, {
      exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x',
      dbPath: s.dbFile, launchAgentsDir: s.laDir
    })
    expect(readFileSync(s.plist, 'utf8')).toBe(LEGACY)
    await built.handle.close()
    rmSync(s.dir, { recursive: true, force: true })
  })
})

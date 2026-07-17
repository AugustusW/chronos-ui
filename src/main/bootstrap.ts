// SPDX-License-Identifier: Apache-2.0
import { spawn, execFile } from 'node:child_process'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { DatabaseHandle } from './db/client'
import { openAndMigrate } from './db/lifecycle'
import { createRepositories } from './db/repositories'
import { readBackendConfig } from './db/backendConfig'
import { schedmgrDbDescriptor } from './scheduler/descriptor'
import { resolveDbPath, resolveMigrationsPaths, type AppPaths } from './db/paths'
import { createAdapter } from './scheduler/factory'
import { resolveSchedmgrPath } from './scheduler/schedmgr-path'
import { makeCrontabExec, makePowerShellExec, type ExecFn } from './scheduler'
import { createJobsService } from './services/jobs.service'
import { createNotifyService } from './services/notify.service'
import { goSecretDir } from './services/notify-secret'
import { type ExecFn as KeychainExecFn } from './services/notify-keychain'
import { createLaunchdFlush, type FlushScheduler } from './services/notify-flush-launchd'
import { runNow, runNowStreaming as runStreamingImpl, type SpawnLike } from './runner/manual-run'
import { makeRunEmitter, type WebContentsLike } from './runner/run-emitter'
import { createBatchRunner } from './runner/batch-run'
import { pgSecretRead } from './services/pg-secret'
import { redactDsn } from './services/pg-dsn'
import { testConnection, switchToPostgres, switchToSqlite, type SwitchResult, type TestConnectionResult } from './services/backend-switch'
import type { IpcDeps } from './ipc'
import type { RunEvent } from '../shared/ipc-contract'

type App = AppPaths & { getName(): string; getVersion(): string; getAppPath(): string }

/** Thrown by buildMainDeps (T11) when the persisted backend config says 'postgres' but the DSN
 *  can't be resolved (missing pgService / no secret found) or the connection itself fails. NEVER
 *  silently caught into a sqlite fallback inside buildMainDeps — index.ts (T12) catches this
 *  specific type to show a blocking "Database unreachable" dialog instead of quietly booting
 *  against the wrong (or no) database. */
export class BootPgUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootPgUnreachableError'
  }
}

/** Same "the raw DSN might appear anywhere in a driver error, not just as a prefix" concern
 *  backend-switch.ts's private redactError guards against (T5) — reimplemented here (rather than
 *  imported) since exporting that function would mean growing backend-switch.ts's public surface
 *  for a single external caller; this is a 2-line pure string helper. */
function redactBootError(err: unknown, dsn: string): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(dsn) ? message.split(dsn).join(redactDsn(dsn)) : redactDsn(message)
}

export interface BuildOpts {
  exec?: ExecFn
  platform?: NodeJS.Platform
  appRoot?: string
  resourcesPath?: string
  dbPath?: string // tests pass ':memory:'
  getWebContents?: () => WebContentsLike | undefined
  spawn?: SpawnLike // test seam: overrides the runNow child spawn so argv can be asserted
  /** T11 test seam: overrides the keychain exec used for the pg-DSN secret read at boot (defaults
   *  to a real `security`/`secret-tool` spawn, same as the notify-token keychain plumbing). */
  execKeychain?: KeychainExecFn
  /** T11 test seam: overrides the pg DSN secret lookup (defaults to the real pgSecretRead). */
  pgSecretRead?: typeof pgSecretRead
  /** T11 test seam: overrides the DB open+migrate step for BOTH dialects (defaults to the real
   *  openAndMigrate) — lets a test fake a postgres open (success or failure) with no real server. */
  openAndMigrate?: typeof openAndMigrate
  /** T12: force the sqlite boot path even when the persisted config says 'postgres' — the
   *  session-only fallback offered by index.ts's "Database unreachable" dialog. Never writes
   *  chronos-config.json (a permanent switch back to sqlite is switchToSqlite, T9/T13). */
  forceSqlite?: boolean
  /** T13: wraps electron's app.relaunch()/app.exit(), called by the pg-settings IPC handler after a
   *  successful backend switch. Defaults to a no-op so non-Electron tests/callers don't need to
   *  supply them. */
  relaunchApp?: () => void
  exitApp?: () => void
}

export interface BuiltDeps {
  deps: IpcDeps
  handle: DatabaseHandle
  emit: (e: RunEvent) => void
  dbPath: string
  /** The non-secret schedmgr `--db` descriptor (path or `pg:keychain:<service>`) baked into cron
   *  lines / Task actions + passed to the runners. Distinct from `dbPath` (the GUI's own file). */
  schedmgrDescriptor: string
  /** Prune run_logs older than `cutoff` (wired to the active dialect's repo) — used by the retention sweep. */
  pruneRunLogs: (cutoff: Date) => Promise<number>
}

/** T12: the two buttons offered by the "Database unreachable" dialog, in showMessageBox order
 *  (index 0 = default = the non-destructive choice; index 1 = cancelId = Quit). */
export const BOOT_PG_UNREACHABLE_BUTTONS = ['Start with SQLite (this session)', 'Quit'] as const

export interface BootErrorUiDeps {
  /** electron's dialog.showMessageBox, narrowed to the one overload this needs. */
  showMessageBox(opts: {
    type: 'error'
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
  }): Promise<{ response: number }>
  /** electron's app.quit — fire-and-forget (Electron itself drives the teardown from here). */
  quit(): void
  /** Rebuilds BuiltDeps forced onto sqlite for THIS session only (buildMainDeps's forceSqlite opt) —
   *  never touches chronos-config.json; a permanent switch back to sqlite is the settings UI's own
   *  switchToSqlite (T9/T13). */
  buildSqliteFallback(): Promise<BuiltDeps>
}

/** T12: index.ts's catch handler for a BootPgUnreachableError out of buildMainDeps. Blocks on a
 *  native dialog rather than silently picking either outcome — the whole point of
 *  BootPgUnreachableError is that the app must never run against the wrong (or a silently
 *  downgraded) database without the user explicitly choosing that. Resolves the fallback BuiltDeps
 *  to continue booting with, or null when the user chose to quit (deps.quit() has already fired —
 *  the caller's whenReady chain should stop wiring anything further, not treat null as an error). */
export async function handleBootPgUnreachable(err: BootPgUnreachableError, deps: BootErrorUiDeps): Promise<BuiltDeps | null> {
  const { response } = await deps.showMessageBox({
    type: 'error',
    message: 'Database unreachable',
    detail: err.message,
    buttons: [...BOOT_PG_UNREACHABLE_BUTTONS],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) {
    deps.quit()
    return null
  }
  return deps.buildSqliteFallback()
}

/** Assemble everything the main process needs. Injectable so it runs under vitest without Electron. */
export async function buildMainDeps(app: App, opts: BuildOpts = {}): Promise<BuiltDeps> {
  const platform = opts.platform ?? process.platform
  const appRoot = opts.appRoot ?? app.getAppPath() // project root in dev; in prod, packaging branches ignore it
  const resourcesPath = opts.resourcesPath ?? process.resourcesPath ?? ''
  const dbPath = opts.dbPath ?? resolveDbPath(app)
  const migrationsPaths = resolveMigrationsPaths(app, { appRoot, resourcesPath })
  const cfg = readBackendConfig(app)

  // Keychain exec shared by (a) the T11 pg-DSN secret read at boot below and (b) the notify
  // service's own token store/read further down — both go through the same darwin `security` /
  // linux `secret-tool` plumbing (notify-keychain.ts), just against different keychain `service`
  // names, so a single spawn-backed implementation (or a single test fake) covers both.
  const execKeychain: KeychainExecFn = opts.execKeychain ?? ((cmd, a, stdin) => new Promise((resolve) => {
    try {
      const child = spawn(cmd, a, { stdio: ['pipe', 'pipe', 'ignore'] })
      let out = ''
      child.stdout?.on('data', (d) => { out += d.toString() })
      child.on('close', (code) => resolve({ code: code ?? 1, stdout: out }))
      child.on('error', () => resolve({ code: 1, stdout: '' }))
      if (stdin !== undefined) child.stdin?.write(stdin)
      child.stdin?.end()
    } catch { resolve({ code: 1, stdout: '' }) }
  }))
  const secretConfigDir = goSecretDir(platform, process.env, homedir())

  const _pgSecretRead = opts.pgSecretRead ?? pgSecretRead
  const _openAndMigrate = opts.openAndMigrate ?? openAndMigrate

  // Boot backend (T11): sqlite is the always-available default (also covers a missing/corrupt
  // config file — readBackendConfig's own fallback) or an explicit session-only forceSqlite (T12's
  // "Database unreachable" fallback); postgres opens straight from the DSN stored at
  // switchToPostgres-time (T8) under `cfg.pgService`. A postgres connection failure here is NEVER
  // silently downgraded to sqlite — it throws a typed BootPgUnreachableError so index.ts can put up
  // a blocking dialog (T12) instead of quietly running against the wrong (or no) DB.
  const handle: DatabaseHandle = await (async () => {
    if (!opts.forceSqlite && cfg.backend === 'postgres') {
      if (!cfg.pgService) {
        throw new BootPgUnreachableError('Postgres backend is selected but no DSN service is configured — re-run the backend switch from Settings.')
      }
      const dsn = await _pgSecretRead(cfg.pgService, { exec: execKeychain, platform, configDir: secretConfigDir })
      if (!dsn) {
        throw new BootPgUnreachableError(`No DSN found in the keychain (or its fallback file) for service "${cfg.pgService}".`)
      }
      try {
        return await _openAndMigrate({ dialect: 'postgres', dsn }, migrationsPaths)
      } catch (err) {
        throw new BootPgUnreachableError(redactBootError(err, dsn))
      }
    }
    // sqlite (default, incl. a missing/corrupt config file, or an explicit forceSqlite fallback).
    // For a :memory: test DB, migrations live in source (dev/test may not have run electron-vite
    // build yet).
    return dbPath === ':memory:'
      ? _openAndMigrate(
          { dialect: 'sqlite', path: ':memory:' },
          {
            sqlite: join(appRoot, 'src/main/db/migrations'),
            pg: join(appRoot, 'src/main/db/migrations.pg')
          }
        )
      : _openAndMigrate({ dialect: 'sqlite', path: dbPath }, migrationsPaths)
  })()

  // Dialect-appropriate repositories (sqlite by default; postgres once the backend switch, T8, has
  // been completed and boot picks it up per the branch above).
  const repos = createRepositories(handle)

  // The schedmgr `--db` descriptor is DISTINCT from the GUI's own db path: postgres →
  // "pg:keychain:<service>" (schedmgr resolves the DSN from the keychain; the crontab carries no
  // secret), sqlite → the path. Boot config defaults to sqlite, so by default this equals dbPath.
  // It is substituted for `dbPath` at every site that bakes it into a schedmgr invocation: the
  // adapter (adopt/create/reconcile cron lines), the service (the unadopt compensating re-adopt),
  // and both runners — NOT the returned dbPath (the GUI file watcher needs the real path).
  const schedmgrDescriptor = schedmgrDbDescriptor(cfg, dbPath)

  const exec = opts.exec ?? (platform === 'win32' ? makePowerShellExec() : makeCrontabExec())
  const schedmgrPath = resolveSchedmgrPath({ isPackaged: app.isPackaged, platform, appRoot, resourcesPath })
  const adapter = createAdapter(platform, exec, { schedmgrPath, dbPath: schedmgrDescriptor })
  const service = createJobsService({ repos, adapter, platform, schedmgrPath, dbPath: schedmgrDescriptor })

  // notify-flush entry: macOS uses a per-user LaunchAgent (avoids the SysAdminFiles "administer this
  // computer" prompt that editing crontab triggers); linux/win delegate to the scheduler adapter.
  const flushScheduler: FlushScheduler =
    platform === 'darwin'
      ? createLaunchdFlush({
          schedmgrPath,
          dbDescriptor: schedmgrDescriptor,
          launchAgentsDir: join(homedir(), 'Library', 'LaunchAgents'),
          uid: process.getuid?.() ?? 0,
          exec: (cmd, a) =>
            new Promise((resolve) => {
              // launchctl writes failures to stderr — fold it in so a non-zero exit has a useful message.
              execFile(cmd, a, (err, stdout, stderr) => {
                const code = (err as { code?: number } | null)?.code
                resolve({ stdout: stdout || stderr || '', exitCode: typeof code === 'number' ? code : err ? 1 : 0 })
              })
            }),
          writeFile: (p, c) => {
            mkdirSync(dirname(p), { recursive: true })
            writeFileSync(p, c)
          },
          rmFile: (p) => {
            try {
              rmSync(p)
            } catch {
              /* best-effort: already gone */
            }
          }
        })
      : { install: (n) => adapter.installFlushEntry(n), remove: () => adapter.removeFlushEntry() }

  const notify = createNotifyService({
    repos, flushScheduler, schedmgrPath, schedmgrDescriptor,
    secretDir: secretConfigDir,
    fetchFn: fetch,
    platform,
    // Runs a keychain CLI (security / secret-tool) capturing stdout + exit code. The token is fed on
    // stdin for secret-tool (Linux), so on Linux it never appears in argv; on macOS `security` takes
    // it as an argument (brief `ps` exposure — see notify-keychain.ts writeCommand). Shared with the
    // T11 pg-DSN secret read above (execKeychain, hoisted to the top of this function).
    execKeychain,
    spawnFlush: (p, a) => new Promise<void>((resolve) => {
      const TIMEOUT_MS = 15_000
      let settled = false
      const settle = (): void => { if (!settled) { settled = true; resolve() } }
      try {
        const child = spawn(p, a, { stdio: 'ignore' })
        const timer = setTimeout(settle, TIMEOUT_MS)
        child.on('close', () => { clearTimeout(timer); settle() })
        child.on('error', () => { clearTimeout(timer); settle() })
      } catch { settle() }
    })
  })

  const emit = makeRunEmitter(opts.getWebContents ?? (() => undefined))

  const runNowStreaming = (id: number): Promise<void> =>
    runStreamingImpl(id, {
      jobs: repos.jobs,
      schedmgrPath,
      dbPath: schedmgrDescriptor,
      spawn: (c, a) => spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] }) as never,
      emit
    })

  const batch = createBatchRunner(runNowStreaming)

  // T13: pg settings-UI IPC wiring. testConnection is stateless (no deps needed — it opens its own
  // short-lived client). switchToPostgres/switchToSqlite reuse the SAME ingredients already
  // assembled above (the currently-open `handle` as the switch's data source, the keychain exec +
  // configDir for the new DSN's secret, the native-scheduler `adapter` for rebakeDescriptors) rather
  // than re-deriving any of them.
  const pgTestConnection = (dsn: string): Promise<TestConnectionResult> => testConnection(dsn)
  const pgSwitchToPostgres = (config: { dsn: string; copy: boolean }): Promise<SwitchResult> =>
    switchToPostgres(config, {
      sqliteHandle: handle,
      migrationsPgPath: migrationsPaths.pg,
      secretDeps: { exec: execKeychain, platform, configDir: secretConfigDir },
      configApp: app,
      sqlitePath: dbPath,
      rebake: { adapter, schedmgrPath }
    })
  const pgSwitchToSqlite = (): Promise<SwitchResult> =>
    switchToSqlite({
      sqliteHandle: handle,
      configApp: app,
      sqlitePath: dbPath,
      rebake: { adapter, schedmgrPath }
    })

  const deps: IpcDeps = {
    meta: { name: app.getName(), version: app.getVersion() },
    service,
    notify,
    runNow: (id) => runNow(id, { jobs: repos.jobs, runLogs: repos.runLogs, schedmgrPath, dbPath: schedmgrDescriptor, spawn: opts.spawn ?? ((c, a) => spawn(c, a)) }),
    listRunsForJob: (jobId, limit) => repos.runLogs.listForJob(jobId, limit),
    recentRuns: (limit) => repos.runLogs.listRecent(limit),
    runNowStreaming,
    cancelBatch: () => batch.cancel(),
    pgTestConnection,
    pgSwitchToPostgres,
    pgSwitchToSqlite,
    relaunchApp: opts.relaunchApp ?? (() => {}),
    exitApp: opts.exitApp ?? (() => {})
  }
  const pruneRunLogs = (cutoff: Date): Promise<number> => repos.runLogs.pruneOlderThan(cutoff)

  return { deps, handle, emit, dbPath, schedmgrDescriptor, pruneRunLogs }
}

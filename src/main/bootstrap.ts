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
import { createLaunchdFlush, type FlushScheduler } from './services/notify-flush-launchd'
import { runNow, runNowStreaming as runStreamingImpl, type SpawnLike } from './runner/manual-run'
import { makeRunEmitter, type WebContentsLike } from './runner/run-emitter'
import { createBatchRunner } from './runner/batch-run'
import type { IpcDeps } from './ipc'
import type { RunEvent } from '../shared/ipc-contract'

type App = AppPaths & { getName(): string; getVersion(): string; getAppPath(): string }

export interface BuildOpts {
  exec?: ExecFn
  platform?: NodeJS.Platform
  appRoot?: string
  resourcesPath?: string
  dbPath?: string // tests pass ':memory:'
  getWebContents?: () => WebContentsLike | undefined
  spawn?: SpawnLike // test seam: overrides the runNow child spawn so argv can be asserted
}

export interface BuiltDeps {
  deps: IpcDeps
  handle: DatabaseHandle
  emit: (e: RunEvent) => void
  dbPath: string
  /** The non-secret schedmgr `--db` descriptor (path or `pg:keychain:<service>`) baked into cron
   *  lines / Task actions + passed to the runners. Distinct from `dbPath` (the GUI's own file). */
  schedmgrDescriptor: string
}

/** Assemble everything the main process needs. Injectable so it runs under vitest without Electron. */
export async function buildMainDeps(app: App, opts: BuildOpts = {}): Promise<BuiltDeps> {
  const platform = opts.platform ?? process.platform
  const appRoot = opts.appRoot ?? app.getAppPath() // project root in dev; in prod, packaging branches ignore it
  const resourcesPath = opts.resourcesPath ?? process.resourcesPath ?? ''
  const dbPath = opts.dbPath ?? resolveDbPath(app)
  const migrationsPaths = resolveMigrationsPaths(app, { appRoot, resourcesPath })

  // Boot is always SQLite in Plan 1 (the user-facing backend switch arrives in Plan 3). For a
  // :memory: test DB, migrations live in source (dev/test may not have run electron-vite build yet).
  const handle =
    dbPath === ':memory:'
      ? await openAndMigrate(
          { dialect: 'sqlite', path: ':memory:' },
          {
            sqlite: join(appRoot, 'src/main/db/migrations'),
            pg: join(appRoot, 'src/main/db/migrations.pg')
          }
        )
      : await openAndMigrate({ dialect: 'sqlite', path: dbPath }, migrationsPaths)

  // Dialect-appropriate repositories (sqlite at boot in Plan 1; pg becomes selectable in Plan 3).
  const repos = createRepositories(handle)

  // The schedmgr `--db` descriptor is DISTINCT from the GUI's own db path: postgres →
  // "pg:keychain:<service>" (schedmgr resolves the DSN from the keychain; the crontab carries no
  // secret), sqlite → the path. Boot config defaults to sqlite, so by default this equals dbPath.
  // It is substituted for `dbPath` at every site that bakes it into a schedmgr invocation: the
  // adapter (adopt/create/reconcile cron lines), the service (the unadopt compensating re-adopt),
  // and both runners — NOT the returned dbPath (the GUI file watcher needs the real path).
  const schedmgrDescriptor = schedmgrDbDescriptor(readBackendConfig(app), dbPath)

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
    secretDir: goSecretDir(platform, process.env, homedir()),
    fetchFn: fetch,
    platform,
    // Runs a keychain CLI (security / secret-tool) capturing stdout + exit code. The token is fed on
    // stdin for secret-tool (Linux), so on Linux it never appears in argv; on macOS `security` takes
    // it as an argument (brief `ps` exposure — see notify-keychain.ts writeCommand).
    execKeychain: (cmd, a, stdin) => new Promise((resolve) => {
      try {
        const child = spawn(cmd, a, { stdio: ['pipe', 'pipe', 'ignore'] })
        let out = ''
        child.stdout?.on('data', (d) => { out += d.toString() })
        child.on('close', (code) => resolve({ code: code ?? 1, stdout: out }))
        child.on('error', () => resolve({ code: 1, stdout: '' }))
        if (stdin !== undefined) child.stdin?.write(stdin)
        child.stdin?.end()
      } catch { resolve({ code: 1, stdout: '' }) }
    }),
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

  const deps: IpcDeps = {
    meta: { name: app.getName(), version: app.getVersion() },
    service,
    notify,
    runNow: (id) => runNow(id, { jobs: repos.jobs, runLogs: repos.runLogs, schedmgrPath, dbPath: schedmgrDescriptor, spawn: opts.spawn ?? ((c, a) => spawn(c, a)) }),
    listRunsForJob: (jobId, limit) => repos.runLogs.listForJob(jobId, limit),
    recentRuns: (limit) => repos.runLogs.listRecent(limit),
    runNowStreaming,
    cancelBatch: () => batch.cancel()
  }
  return { deps, handle, emit, dbPath, schedmgrDescriptor }
}

// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { DatabaseHandle } from './db/client'
import { openAndMigrate } from './db/lifecycle'
import { resolveDbPath, resolveMigrationsPath, type AppPaths } from './db/paths'
import { listRunsForJob, listRecentRuns } from './db/runLogs.repository'
import { createAdapter } from './scheduler/factory'
import { resolveSchedmgrPath } from './scheduler/schedmgr-path'
import { makeCrontabExec, makePowerShellExec, type ExecFn } from './scheduler'
import { createJobsService } from './services/jobs.service'
import { runNow, runNowStreaming as runStreamingImpl } from './runner/manual-run'
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
}

export interface BuiltDeps {
  deps: IpcDeps
  handle: DatabaseHandle
  emit: (e: RunEvent) => void
  dbPath: string
}

/** Assemble everything the main process needs. Injectable so it runs under vitest without Electron. */
export function buildMainDeps(app: App, opts: BuildOpts = {}): BuiltDeps {
  const platform = opts.platform ?? process.platform
  const appRoot = opts.appRoot ?? app.getAppPath() // project root in dev; in prod, packaging branches ignore it
  const resourcesPath = opts.resourcesPath ?? process.resourcesPath ?? ''
  const dbPath = opts.dbPath ?? resolveDbPath(app)
  const migrationsPath = resolveMigrationsPath(app, { appRoot, resourcesPath })

  // For a :memory: test DB, migrations live in source (dev/test may not have run electron-vite build yet).
  const handle =
    dbPath === ':memory:'
      ? openAndMigrate(':memory:', join(appRoot, 'src/main/db/migrations'))
      : openAndMigrate(dbPath, migrationsPath)

  const exec = opts.exec ?? (platform === 'win32' ? makePowerShellExec() : makeCrontabExec())
  const schedmgrPath = resolveSchedmgrPath({ isPackaged: app.isPackaged, platform, appRoot, resourcesPath })
  const adapter = createAdapter(platform, exec, { schedmgrPath, dbPath })
  const service = createJobsService({ db: handle.db, adapter, platform, schedmgrPath, dbPath })

  const emit = makeRunEmitter(opts.getWebContents ?? (() => undefined))

  const runNowStreaming = (id: number): Promise<void> =>
    runStreamingImpl(id, {
      db: handle.db,
      schedmgrPath,
      dbPath,
      spawn: (c, a) => spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] }) as never,
      emit
    })

  const batch = createBatchRunner(runNowStreaming)

  const deps: IpcDeps = {
    meta: { name: app.getName(), version: app.getVersion() },
    service,
    runNow: (id) => runNow(id, { db: handle.db, schedmgrPath, dbPath, spawn: (c, a) => spawn(c, a) }),
    listRunsForJob: (jobId, limit) => listRunsForJob(handle.db, jobId, limit),
    recentRuns: (limit) => listRecentRuns(handle.db, limit),
    runNowStreaming,
    cancelBatch: () => batch.cancel()
  }
  return { deps, handle, emit, dbPath }
}

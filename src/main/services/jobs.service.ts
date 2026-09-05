// SPDX-License-Identifier: Apache-2.0
import type { Repositories } from '../db/repositories'
import type { Job } from '../db/schema'
import type { AdoptionSpec, BatchWriteResult, SchedulerAdapter, WriteResult } from '../scheduler/types'
import type { AdoptItem, CreateJobInput, ReconcileResult, UpdateJobChanges } from '../../shared/ipc-contract'
import { reconcile } from './reconcile'
import type { FlushScheduler } from './notify-flush-launchd'

export interface JobsServiceDeps {
  repos: Repositories
  adapter: SchedulerAdapter
  platform: NodeJS.Platform
  schedmgrPath: string // used by the compensating re-adopt in unadopt (plan-advisor MEDIUM #3)
  dbPath: string
  // --- teardown only. Injected rather than imported so this unit stays testable without electron. ---
  /** Absolute path of chronos-config.json, from backendConfig.configPath(app). */
  configPath?: string
  /**
   * Absolute path of the local SQLite file, from resolveDbPath(app).
   * Deliberately NOT `dbPath` above: that one is the schedmgr *descriptor*, which on a PostgreSQL
   * backend is `pg:keychain:<service>` and not a file at all. Deleting it would silently do nothing
   * while leaving the real local database on disk.
   */
  sqliteDbPath?: string
  /** File remover. Injectable for the same reason rmFile is injectable in notify-flush-launchd. */
  rmFile?: (path: string) => void
  /** macOS LaunchAgent flush scheduler; null/absent on platforms that use the adapter's cron entry. */
  flush?: FlushScheduler | null
  /** app.quit(), injected (native-notify.service.ts uses the same injectable-default pattern). */
  quit?: () => void
}

/** What teardown did. `skipped` are jobs the native scheduler no longer knows about; `deleteFailed`
 *  are files it was asked to delete but could not (a Windows EBUSY on the still-open SQLite file is
 *  the realistic case). Either one being non-empty means the app does NOT quit itself: there is
 *  something the user needs to see, and quitting would take the only surface that could show it. */
export interface TeardownResult {
  ok: boolean
  error?: string
  released: number[]
  skipped: { chronosId: number; reason: 'no_match' }[]
  deleteFailed: string[]
}

function sourceFor(platform: NodeJS.Platform): 'native_cron' | 'native_task' {
  return platform === 'win32' ? 'native_task' : 'native_cron'
}
function dbPlatform(platform: NodeJS.Platform): 'darwin' | 'linux' | 'win32' {
  return platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
}

export interface JobsService {
  create(input: CreateJobInput): Promise<WriteResult & { job?: Job }>
  update(id: number, changes: UpdateJobChanges): Promise<WriteResult & { job?: Job }>
  enable(id: number): Promise<WriteResult>
  disable(id: number): Promise<WriteResult>
  remove(id: number): Promise<WriteResult>
  adopt(items: AdoptItem[]): Promise<BatchWriteResult>
  unadopt(id: number): Promise<WriteResult>
  forget(id: number): Promise<WriteResult>
  list(): Promise<ReconcileResult>
  managedCount(): Promise<number>
  /** Release every job, drop our scheduled entry, optionally delete local data, then quit. */
  teardown(opts: { deleteData: boolean }): Promise<TeardownResult>
}

export function createJobsService(deps: JobsServiceDeps): JobsService {
  const { repos, adapter, platform, schedmgrPath, dbPath } = deps

  return {
    async create(input) {
      const job = await repos.jobs.create({
        name: input.name,
        source: sourceFor(platform),
        platform: dbPlatform(platform),
        scheduleExpr: input.scheduleExpr,
        command: input.command,
        workingDir: input.workingDir ?? null,
        env: input.env ?? null,
        enabled: true,
        adopted: false,
        timeoutSec: input.timeoutSec ?? null,
        category: input.category ?? null,
        notifyOnFailure: input.notifyOnFailure ?? false
      })
      const w = await adapter.createJob({ chronosId: job.id, scheduleExpr: input.scheduleExpr, command: input.command })
      if (!w.ok) {
        await repos.jobs.remove(job.id) // compensating action — leave neither a DB row nor a native line
        return w
      }
      return { ...w, job }
    },

    async update(id, changes) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      // Native scheduler is the source of truth for schedule/command — apply there first, but
      // only when they actually change. The editor always re-sends the full form (incl. the
      // unchanged command); forwarding an unchanged command trips the adapter's "cannot change an
      // adopted job's command" guard, which would abort a pure name/category edit before the DB
      // write (a silent rename no-op). Diff against `existing` and forward only what changed.
      const schedChanged = changes.scheduleExpr !== undefined && changes.scheduleExpr !== existing.scheduleExpr
      const cmdChanged = changes.command !== undefined && changes.command !== existing.command
      if (schedChanged || cmdChanged) {
        const w = await adapter.updateJob(id, {
          scheduleExpr: schedChanged ? changes.scheduleExpr : undefined,
          command: cmdChanged ? changes.command : undefined
        })
        if (!w.ok) return w
      }
      const job = await repos.jobs.update(id, {
        name: changes.name,
        scheduleExpr: changes.scheduleExpr,
        command: changes.command,
        workingDir: changes.workingDir,
        env: changes.env,
        timeoutSec: changes.timeoutSec,
        category: changes.category,
        notifyOnFailure: changes.notifyOnFailure
      })
      return { ok: true, job }
    },

    async enable(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.enableJob(id)
      if (!w.ok) return w
      await repos.jobs.update(id, { enabled: true })
      return w
    },

    async disable(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.disableJob(id)
      if (!w.ok) return w
      await repos.jobs.update(id, { enabled: false })
      return w
    },

    async remove(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.deleteJob(id)
      if (!w.ok) return w
      await repos.jobs.remove(id) // run_logs cascade (schema onDelete: 'cascade')
      return w
    },

    async adopt(items) {
      if (items.length === 0) return { ok: true, adopted: [] }
      // Insert a DB row per item (capturing the original command), adopted=false until the wrap
      // succeeds. Sequential (not Promise.all) — faithful to the original sqlite path and keeps
      // generated ids ascending in input order; concurrent inserts on a pg pool would not.
      const inserted: Job[] = []
      for (const it of items) {
        inserted.push(
          await repos.jobs.create({
            name: it.name ?? '', // #8: blank by default (cron has no name → user names it); Windows passes the Task Scheduler name
            source: sourceFor(platform),
            platform: dbPlatform(platform),
            scheduleExpr: it.scheduleExpr,
            command: it.command,
            enabled: true,
            adopted: false,
            category: it.category ?? null
          })
        )
      }
      const specs: AdoptionSpec[] = inserted.map((j, i) => ({ chronosId: j.id, scheduleExpr: items[i].scheduleExpr, command: items[i].command }))
      const r = await adapter.adoptMany(specs)
      const kept = new Set(r.adopted)
      for (const j of inserted) {
        if (kept.has(j.id)) await repos.jobs.update(j.id, { adopted: true })
        else await repos.jobs.remove(j.id) // compensating: drop rows the adapter did not wrap
      }
      return r
    },

    async forget(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      if (existing.adopted) return { ok: false, reason: 'error', error: 'adopted job — use unadopt to revert the wrap' }
      await repos.jobs.remove(id) // DB only; crontab untouched (run_logs cascade)
      return { ok: true }
    },

    async unadopt(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.unadopt(id, existing.command) // adapter first (native is source of truth)
      if (!w.ok) return w
      const patched = await repos.jobs.update(id, { adopted: false })
      if (!patched) {
        // DB write failed after the native change — re-adopt so the DB flag never lies (design §6).
        // Uses the service's real schedmgrPath/dbPath (plan-advisor MEDIUM #3) so the re-wrapped line is valid.
        await adapter.adopt(id, { scheduleExpr: existing.scheduleExpr, command: existing.command, schedmgrPath, dbPath })
        return { ok: false, reason: 'error', errorCode: 'db_error', error: 'db patch failed; re-adopted to stay consistent' }
      }
      return w
    },

    async list() {
      const [native, dbJobs] = await Promise.all([adapter.list(), repos.jobs.list()])
      return reconcile(native, dbJobs)
    },

    async managedCount() {
      return (await repos.jobs.list()).length
    },

    // Teardown: the user is removing ChronosUI. Hand every job back to the native scheduler, drop our
    // own scheduled entry, and only then (and only if asked) delete local data.
    //
    // The order is the whole point. The DB is what tells us each job's ORIGINAL command, so it must be
    // read before anything is deleted, and releaseAll must succeed before a single file goes: a failed
    // release plus a deleted database leaves the user with wrapped crontab lines and nothing left to
    // reconstruct them from.
    async teardown({ deleteData }) {
      const jobs = await repos.jobs.list()
      const specs = jobs.map((j) => ({ chronosId: j.id, originalCommand: j.command }))

      const r = await adapter.releaseAll(specs)
      if (!r.ok) {
        return {
          ok: false,
          error: r.error ?? (r.reason === 'drift' ? 'the native scheduler changed underneath us' : 'release failed'),
          released: r.released,
          skipped: r.skipped,
          deleteFailed: []
        }
      }

      // Our own scheduled entry: a LaunchAgent on macOS, a cron line / task elsewhere.
      if (deps.flush) await deps.flush.remove()
      else await adapter.removeFlushEntry()

      const deleteFailed: string[] = []
      if (deleteData) {
        // Asked to delete but not wired to: report it. Silently skipping is the exact failure this
        // whole feature exists to remove (code review, Important #3).
        if (!deps.rmFile) {
          return {
            ok: false,
            error: 'cannot delete local data: no file remover is configured',
            released: r.released,
            skipped: r.skipped,
            deleteFailed: []
          }
        }
        // Exactly these two files. Not the whole userData directory — Electron keeps unrelated state
        // there. A PostgreSQL backend's data is untouched on purpose: that database is the user's own,
        // and dropping it is far outside what "remove this app" asks for.
        for (const p of [deps.sqliteDbPath, deps.configPath].filter((x): x is string => !!x)) {
          try {
            deps.rmFile(p)
          } catch {
            // The SQLite handle is still open at this point. Unix unlinks an open file happily;
            // Windows refuses. Collect rather than throw so the other file still gets its turn.
            deleteFailed.push(p)
          }
        }
      }

      // Quit only on a fully clean run. Anything the user still needs to know about (jobs we could
      // not find, files we could not delete) has to stay on screen, and spec §2 step 5 asked for the
      // skipped list to be shown — quitting unconditionally is what silently dropped it.
      if (r.skipped.length === 0 && deleteFailed.length === 0) deps.quit?.()
      return { ok: true, released: r.released, skipped: r.skipped, deleteFailed }
    }
  }
}

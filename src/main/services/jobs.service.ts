// SPDX-License-Identifier: Apache-2.0
import type { Repositories } from '../db/repositories'
import type { Job } from '../db/schema'
import type { AdoptionSpec, BatchWriteResult, SchedulerAdapter, WriteResult } from '../scheduler/types'
import type { AdoptItem, CreateJobInput, ReconcileResult, UpdateJobChanges } from '../../shared/ipc-contract'
import { reconcile } from './reconcile'

export interface JobsServiceDeps {
  repos: Repositories
  adapter: SchedulerAdapter
  platform: NodeJS.Platform
  schedmgrPath: string // used by the compensating re-adopt in unadopt (plan-advisor MEDIUM #3)
  dbPath: string
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
  list(): Promise<ReconcileResult>
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
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
import type { ChronosDb } from '../db/client'
import { createJob, deleteJob, getJob, listJobs, updateJob } from '../db/jobs.repository'
import type { Job } from '../db/schema'
import type { AdoptionSpec, BatchWriteResult, SchedulerAdapter, WriteResult } from '../scheduler/types'
import type { AdoptItem, CreateJobInput, ReconcileResult, UpdateJobChanges } from '../../shared/ipc-contract'
import { reconcile } from './reconcile'

export interface JobsServiceDeps {
  db: ChronosDb
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
  const { db, adapter, platform, schedmgrPath, dbPath } = deps

  return {
    async create(input) {
      const job = createJob(db, {
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
        category: input.category ?? null
      })
      const w = await adapter.createJob({ chronosId: job.id, scheduleExpr: input.scheduleExpr, command: input.command })
      if (!w.ok) {
        deleteJob(db, job.id) // compensating action — leave neither a DB row nor a native line
        return w
      }
      return { ...w, job }
    },

    async update(id, changes) {
      const existing = getJob(db, id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      // Native scheduler is the source of truth for schedule/command — apply there first.
      if (changes.scheduleExpr !== undefined || changes.command !== undefined) {
        const w = await adapter.updateJob(id, { scheduleExpr: changes.scheduleExpr, command: changes.command })
        if (!w.ok) return w
      }
      const job = updateJob(db, id, {
        name: changes.name,
        scheduleExpr: changes.scheduleExpr,
        command: changes.command,
        workingDir: changes.workingDir,
        env: changes.env,
        timeoutSec: changes.timeoutSec,
        category: changes.category
      })
      return { ok: true, job }
    },

    async enable(id) {
      const existing = getJob(db, id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.enableJob(id)
      if (!w.ok) return w
      updateJob(db, id, { enabled: true })
      return w
    },

    async disable(id) {
      const existing = getJob(db, id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.disableJob(id)
      if (!w.ok) return w
      updateJob(db, id, { enabled: false })
      return w
    },

    async remove(id) {
      const existing = getJob(db, id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.deleteJob(id)
      if (!w.ok) return w
      deleteJob(db, id) // run_logs cascade (schema onDelete: 'cascade')
      return w
    },

    async adopt(items) {
      if (items.length === 0) return { ok: true, adopted: [] }
      // Insert a DB row per item (capturing the original command), adopted=false until the wrap succeeds.
      const inserted = items.map((it) =>
        createJob(db, {
          name: it.name ?? it.command.slice(0, 60),
          source: sourceFor(platform),
          platform: dbPlatform(platform),
          scheduleExpr: it.scheduleExpr,
          command: it.command,
          enabled: true,
          adopted: false
        })
      )
      const specs: AdoptionSpec[] = inserted.map((j, i) => ({ chronosId: j.id, scheduleExpr: items[i].scheduleExpr, command: items[i].command }))
      const r = await adapter.adoptMany(specs)
      const kept = new Set(r.adopted)
      for (const j of inserted) {
        if (kept.has(j.id)) updateJob(db, j.id, { adopted: true })
        else deleteJob(db, j.id) // compensating: drop rows the adapter did not wrap
      }
      return r
    },

    async unadopt(id) {
      const existing = getJob(db, id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.unadopt(id, existing.command) // adapter first (native is source of truth)
      if (!w.ok) return w
      const patched = updateJob(db, id, { adopted: false })
      if (!patched) {
        // DB write failed after the native change — re-adopt so the DB flag never lies (design §6).
        // Uses the service's real schedmgrPath/dbPath (plan-advisor MEDIUM #3) so the re-wrapped line is valid.
        await adapter.adopt(id, { scheduleExpr: existing.scheduleExpr, command: existing.command, schedmgrPath, dbPath })
        return { ok: false, reason: 'error', errorCode: 'db_error', error: 'db patch failed; re-adopted to stay consistent' }
      }
      return w
    },

    async list() {
      const [native, dbJobs] = [await adapter.list(), listJobs(db)]
      return reconcile(native, dbJobs)
    }
  }
}

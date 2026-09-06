// SPDX-License-Identifier: Apache-2.0
import type { Repositories } from '../db/repositories'
import type { Job } from '../db/schema'
import type { AdoptionSpec, BatchWriteResult, SchedulerAdapter, WriteResult } from '../scheduler/types'
import type { AdoptItem, CreateJobInput, ReconcileResult, UpdateJobChanges } from '../../shared/ipc-contract'
import { reconcile } from './reconcile'
import { diffJobConfig, type JobConfigLike } from './job-revisions'
import type { RevisionSource } from '../db/repositories'
import { DRIFT_SOURCES } from '../db/jobRevisions.repository'
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
  skipped: { chronosId: number; reason: 'no_match' | 'ambiguous' }[]
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
  /** Push the DB's schedule + command into the native scheduler — see the implementation's comment
   *  for why reverting an EXTERNAL change cannot go through update(). */
  restoreToScheduler(id: number): Promise<WriteResult>
  forget(id: number): Promise<WriteResult>
  list(): Promise<ReconcileResult>
  managedCount(): Promise<number>
  /** Release every job, drop our scheduled entry, optionally delete local data, then quit. */
  teardown(opts: { deleteData: boolean }): Promise<TeardownResult>
}

export function createJobsService(deps: JobsServiceDeps): JobsService {
  const { repos, adapter, platform, schedmgrPath, dbPath } = deps

  /**
   * Write a revision if anything tracked actually changed. Best-effort by design: the change has
   * already landed in the native scheduler and the DB by the time we get here, so a failure to
   * record history must not turn a successful edit into a reported failure. Losing one history
   * row is bad; telling the user their edit failed when it did not is worse.
   */
  async function recordRevision(
    before: JobConfigLike,
    after: JobConfigLike,
    jobId: number,
    source: RevisionSource
  ): Promise<void> {
    const diff = diffJobConfig(before, after)
    if (!diff) return
    try {
      await repos.jobRevisions.record({ jobId, source, ...diff })
    } catch (e) {
      console.warn(`[jobs.service] could not record ${source} revision for job ${jobId}:`, e)
    }
  }

  /**
   * A per-process cache of what we last saw for each job: a signature of the observed drift, or
   * `null` for "seen in sync". PURELY an optimisation — it saves one query per job per poll, and
   * every decision it short-circuits is one the database would answer the same way.
   *
   * Correctness lives in the stored history instead (see recordExternalChanges): whether a drift is
   * still standing is read from the newest {external, resolved} revision, which survives a restart.
   * An earlier version carried that state only here, and a drift that was undone and repeated while
   * the app was closed went unrecorded.
   */
  const lastDriftSignature = new Map<number, string | null>()

  /**
   * A job is back in sync. If the stored history still ends on an unresolved `external`, close it
   * out with a `resolved` revision — the same change, read the other way round.
   *
   * This is what makes the log honest in both directions. Without it a job's history can end at
   * "command changed to something else" months after someone put it back, and — because the newest
   * external revision would still look like the current state — an identical change made again
   * would be mistaken for that same standing drift and silently dropped.
   */
  async function recordDriftResolved(jobId: number, observed: Record<string, unknown>): Promise<void> {
    const last = await repos.jobRevisions.getLatest(jobId, DRIFT_SOURCES)
    if (last?.source !== 'external') return
    await repos.jobRevisions.record({
      jobId,
      source: 'resolved',
      changedFields: last.changedFields,
      before: last.after, // what the scheduler had been changed to
      // What it is NOW, read off the scheduler — NOT `last.before`. Inverting the stored row
      // assumes the job came back to the value it had when the drift was recorded, and it may not
      // have: if the user resolved the difference by editing the job to a third value, inverting
      // claims a state that never existed anywhere.
      after: Object.fromEntries(last.changedFields.map((f) => [f, observed[f]]))
    })
  }

  /**
   * Record edits somebody made directly in crontab / Task Scheduler. reconcile() has already done
   * the comparison — a `drifted` item carries the DB row (what ChronosUI last knew) and the native
   * line (what is there now), which is exactly before/after.
   *
   * De-duplication is required, not an optimisation: reconcile is deliberately non-destructive, so
   * the DB row keeps its old values and the same difference is re-observed on every list() — every
   * UI refresh AND every 45s background poll. Resolutions are written here too, so this function
   * maintains both halves of the drift story.
   *
   * Restricted to the three fields reconcile itself calls drift (scheduleExpr / command / enabled)
   * so there is one definition of "drifted" in the codebase rather than two.
   */
  async function recordExternalChanges(result: ReconcileResult): Promise<void> {
    for (const item of result.items) {
      const dbJob = item.job
      if (!dbJob) continue
      // Only these two statuses carry a native side to observe. `vanished` in particular must NOT
      // reach inSync: the entry was DELETED, and closing out a drift there would record that the
      // scheduler was put back when nothing is running at all.
      if ((item.status !== 'drifted' && item.status !== 'in_sync') || !item.native) continue
      const nativeValues: Record<string, unknown> = {
        scheduleExpr: item.native.scheduleExpr,
        command: item.native.command,
        enabled: item.native.enabled
      }
      if (item.status === 'in_sync') {
        await inSync(dbJob.id, nativeValues)
        continue
      }
      const observed: JobConfigLike = { ...dbJob, ...(nativeValues as Partial<JobConfigLike>) }
      const diff = diffJobConfig(dbJob, observed)
      if (!diff) {
        await inSync(dbJob.id, nativeValues)
        continue
      }
      const signature = JSON.stringify([diff.changedFields, diff.before, diff.after])
      if (lastDriftSignature.get(dbJob.id) === signature) continue // cache hit: already recorded
      try {
        // Record only the fields the standing external does not ALREADY describe, field by field.
        // A whole-diff comparison would re-record a difference that is still standing whenever a
        // second field is resolved — reading as though the same edit had been made twice.
        // A `resolved` as the newest row means the scheduler was put back, so nothing is standing
        // and an identical change is a fresh occurrence that must be recorded.
        const last = await repos.jobRevisions.getLatest(dbJob.id, DRIFT_SOURCES)
        const standing = last?.source === 'external' ? last : undefined
        const novel = diff.changedFields.filter(
          (f) => !(standing && standing.before[f] === diff.before[f] && standing.after[f] === diff.after[f])
        )
        if (novel.length > 0) {
          await repos.jobRevisions.record({
            jobId: dbJob.id,
            source: 'external',
            changedFields: novel,
            before: Object.fromEntries(novel.map((f) => [f, diff.before[f]])),
            after: Object.fromEntries(novel.map((f) => [f, diff.after[f]]))
          })
        }
        lastDriftSignature.set(dbJob.id, signature)
      } catch (e) {
        // list() is a read path the whole UI depends on; never fail it over bookkeeping.
        console.warn(`[jobs.service] could not record external revision for job ${dbJob.id}:`, e)
      }
    }
  }

  /** The job agrees with the scheduler: close out a standing drift, then remember we saw sync. */
  async function inSync(jobId: number, observed: Record<string, unknown>): Promise<void> {
    if (lastDriftSignature.get(jobId) === null) return // cache hit: already handled this process
    try {
      await recordDriftResolved(jobId, observed)
      // Only mark it handled once the write actually succeeded. Setting it regardless would let a
      // single transient failure suppress the resolution for the life of the process — the drift
      // path already gets this right, and the two must not disagree.
      lastDriftSignature.set(jobId, null)
    } catch (e) {
      console.warn(`[jobs.service] could not record drift resolution for job ${jobId}:`, e)
    }
  }

  /**
   * list() is called on mount by three views, on every jobsChanged event, and by a 45s poll, so
   * several calls are routinely in flight at once. Since it now WRITES, concurrent calls would
   * each read "nothing recorded yet" before any of them writes, landing the same external change
   * two or three times.
   *
   * Only the WRITE is serialised, deliberately. Sharing one in-flight promise for the whole of
   * list() would also share its snapshot: every UI write path calls refresh() right after writing,
   * and if a 45s poll happened to be mid-flight that caller would be handed the pre-write state
   * and show it until the next poll. Queuing just the recorder keeps reads independent and still
   * closes the race, because by the time the second recorder runs the first has already marked the
   * drift in lastDriftSignature.
   */
  let recordChain: Promise<void> = Promise.resolve()
  function recordExternalChangesSerialised(result: ReconcileResult): Promise<void> {
    const next = recordChain.then(() => recordExternalChanges(result))
    recordChain = next.catch(() => {}) // a failed recorder must not poison the queue
    return next
  }

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
      if (!job) {
        // The native scheduler has already been changed at this point, so reporting success would
        // leave the user believing an edit landed that our own records do not have. Mirrors the
        // db_error unadopt() returns in the same situation.
        return {
          ok: false,
          reason: 'error',
          errorCode: 'db_error',
          error: `the scheduler was updated but job ${id} could not be recorded; the scheduler now has the new values`
        }
      }
      await recordRevision(existing, job, id, 'edit')
      return { ok: true, job }
    },

    async enable(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.enableJob(id)
      if (!w.ok) return w
      const job = await repos.jobs.update(id, { enabled: true })
      if (job) await recordRevision(existing, job, id, 'edit')
      return w
    },

    async disable(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      const w = await adapter.disableJob(id)
      if (!w.ok) return w
      const job = await repos.jobs.update(id, { enabled: false })
      if (job) await recordRevision(existing, job, id, 'edit')
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
      const specs: AdoptionSpec[] = inserted.map((j, i) => ({
        chronosId: j.id,
        scheduleExpr: items[i].scheduleExpr,
        command: items[i].command,
        native: items[i].native
      }))
      const r = await adapter.adoptMany(specs)
      const kept = new Set(r.adopted)
      const flipFailed: number[] = []
      const flipUndoFailed: number[] = []
      for (const j of inserted) {
        if (kept.has(j.id)) {
          const adoptedJob = await repos.jobs.update(j.id, { adopted: true })
          if (adoptedJob) {
            await recordRevision(j, adoptedJob, j.id, 'adopt')
          } else {
            // The line is wrapped but the DB flag was not set. Leaving it would report an adopted
            // job that the DB says is not adopted — the same lie unadopt() compensates for in the
            // mirror case. Unwrap it again and drop it from the reported result.
            const undo = await adapter.unadopt(j.id, j.command)
            if (undo.ok) {
              await repos.jobs.remove(j.id)
              flipFailed.push(j.id)
            } else {
              // The unwrap failed too. Removing the row now would strand a wrapped scheduler line
              // with no DB row behind it — unrunnable, and teardown could no longer restore the
              // original command because the row is what remembers it. Keep the row.
              flipUndoFailed.push(j.id)
            }
          }
        } else {
          await repos.jobs.remove(j.id) // compensating: drop rows the adapter did not wrap
        }
      }
      if (flipFailed.length > 0 || flipUndoFailed.length > 0) {
        const parts: string[] = []
        if (flipFailed.length > 0) parts.push(`reverted: ${flipFailed.join(', ')}`)
        // Say what is actually true of the scheduler — claiming a revert that did not happen is the
        // failure this branch exists to avoid.
        if (flipUndoFailed.length > 0) parts.push(`still wrapped in the scheduler: ${flipUndoFailed.join(', ')}`)
        return {
          ok: false,
          reason: 'error',
          errorCode: 'db_error',
          error: `adopted in the scheduler but could not be recorded; ${parts.join('; ')}`,
          adopted: r.adopted.filter((id) => !flipFailed.includes(id) && !flipUndoFailed.includes(id))
        }
      }
      return r
    },

    async forget(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      // Ask the SCHEDULER, not just the DB flag. adopt()'s compensation can leave a wrapped line
      // behind a row that still says adopted:false (when the unwrap itself failed), and forgetting
      // that row would strand the wrapped line with nothing left that remembers its original
      // command — the very outcome the compensation keeps the row to avoid.
      const native = (await adapter.list()).find((p) => p.chronosId === id)
      if (existing.adopted || native?.adopted) {
        return { ok: false, reason: 'error', error: 'adopted job — use unadopt to revert the wrap' }
      }
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
      await recordRevision(existing, patched, id, 'unadopt')
      return w
    },

    async list() {
      const [native, dbJobs] = await Promise.all([adapter.list(), repos.jobs.list()])
      const result = reconcile(native, dbJobs)
      await recordExternalChangesSerialised(result)
      return result
    },

    /**
     * Push the DB's schedule and command into the native scheduler, unconditionally.
     *
     * This is the drift-resolution direction, and it exists because `update()` cannot do it:
     * update() forwards a field to the adapter only when it differs from the DB row, and after an
     * EXTERNAL change the DB row already holds the value being restored — so update() would skip
     * the adapter entirely, change nothing, and report success while the foreign command kept
     * running. Restoring is therefore its own operation, not an edit.
     *
     * The DB is not written: it already holds these values. On an adopted job the adapter refuses
     * an in-place command change (the wrapper would be stripped), and that refusal is returned
     * verbatim rather than worked around.
     */
    async restoreToScheduler(id) {
      const existing = await repos.jobs.get(id)
      if (!existing) return { ok: false, reason: 'error', errorCode: 'not_found', error: `no job ${id}` }
      // Reading the scheduler here also refreshes the adapter's drift snapshot, so the write below
      // is not blocked by the very difference we are here to undo. That is deliberate: restoring is
      // an explicit "make the scheduler match this app" instruction, not an ordinary edit.
      const native = (await adapter.list()).find((p) => p.chronosId === id)

      // Forward ONLY what actually differs. Sending `command` unconditionally trips the adapter's
      // "cannot change an adopted job's command" guard on a field the user never touched, turning
      // a fixable schedule-only drift into a dead end that names the wrong thing.
      const changes: { scheduleExpr?: string; command?: string } = {}
      if (!native || native.scheduleExpr !== existing.scheduleExpr) changes.scheduleExpr = existing.scheduleExpr
      if (!native || native.command !== existing.command) changes.command = existing.command
      if (changes.scheduleExpr !== undefined || changes.command !== undefined) {
        const w = await adapter.updateJob(id, changes)
        if (!w.ok) return w
      }

      // `enabled` lives in the line's comment prefix, which adapter.updateJob recomputes from the
      // CURRENT native state — so a line someone commented out stays commented out no matter what
      // we send. It has to be put back through enable/disable or the restore silently does nothing
      // for the one field that used to work.
      if (native && native.enabled !== existing.enabled) {
        const w = existing.enabled ? await adapter.enableJob(id) : await adapter.disableJob(id)
        if (!w.ok) return w
      }
      return { ok: true }
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

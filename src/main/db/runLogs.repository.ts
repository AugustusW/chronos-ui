// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { jobs, runLogs, type RunLog } from './schema'
import { keepLastBytes } from './output'

/** One point of a job's run-duration trend (v0.4.0, JobDetailView's sparkline). Just the fields the
 *  sparkline needs — not a full RunLog — so the query stays narrow. */
export interface RunDurationPoint {
  durationMs: number | null
  result: 'success' | 'failure' | 'timeout'
  startedAt: Date
}

/** v0.4.0 Run History search (RunHistoryView.vue). Types + the dialect-agnostic escape helper live
 *  here (not duplicated) so runLogs.repository.pg.ts imports them — same pattern
 *  dashboard.repository.ts already established for FailureRow/RunOutcomeRow. */
export interface RunSearchFilters {
  jobId?: number
  result?: 'success' | 'failure' | 'timeout'
  /** Inclusive lower bound on startedAt — the renderer resolves a date-range PRESET ('today' / '7d'
   *  / '30d' / 'all') down to this single Date (or omits it for 'all'); the query layer only ever
   *  sees a plain bound, not preset semantics. */
  since?: Date
  /** Case-insensitive substring match across the job name + stdout + stderr. */
  searchText?: string
  limit: number
}

/** A run_logs row joined with its job's name — Run History needs the name to display/search by job
 *  without a second round-trip; the plain RunLog type (listRecent/listForJob above) doesn't carry it. */
export interface RunLogWithJob extends RunLog {
  jobName: string
}

/** Escapes SQL LIKE/ILIKE metacharacters (`%`, `_`, and the escape char itself) in free-text user
 *  input, paired with an explicit `ESCAPE '\'` clause at the call site — otherwise a literal search
 *  term containing `%` or `_` would silently behave as a wildcard instead of matching literally. */
export function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** Delete run_logs whose startedAt is strictly before `cutoff`; returns the number of rows removed.
 *  Run history is otherwise insert-only and unbounded (~520k rows/year for a per-minute job), so a
 *  retention sweep bounds the table on disk (review #4). The (jobId, startedAt, id) index also serves
 *  this DELETE's startedAt range.
 *  NOTE: better-sqlite3 is synchronous, so a very large first prune (a long-unpruned per-minute job)
 *  briefly blocks the main process. Acceptable for a desktop app + matches the rest of this repo; if
 *  it ever bites, batch with DELETE … LIMIT in a loop yielding between batches. */
export function pruneRunsOlderThan(db: ChronosDb, cutoff: Date): number {
  return db.delete(runLogs).where(lt(runLogs.startedAt, cutoff)).run().changes
}

export function startRun(
  db: ChronosDb,
  input: { jobId: number; triggeredBy: 'schedule' | 'manual'; startedAt?: Date }
): RunLog {
  return db
    .insert(runLogs)
    .values({
      jobId: input.jobId,
      triggeredBy: input.triggeredBy,
      startedAt: input.startedAt ?? new Date()
    })
    .returning()
    .get()
}

export function finishRun(
  db: ChronosDb,
  id: number,
  input: {
    result: 'success' | 'failure' | 'timeout'
    endedAt?: Date
    exitCode?: number
    stdout?: string
    stderr?: string
  }
): RunLog | undefined {
  // Wrap the read-then-write in a transaction so durationMs is computed from the SAME startedAt the
  // UPDATE commits against — another process (schedmgr) can't interleave a write between the two
  // statements (review #11). better-sqlite3 transactions are synchronous.
  return db.transaction((tx) => {
    const existing = tx.select().from(runLogs).where(eq(runLogs.id, id)).get()
    if (!existing) return undefined
    const endedAt = input.endedAt ?? new Date()
    return tx
      .update(runLogs)
      .set({
        result: input.result,
        endedAt,
        durationMs: endedAt.getTime() - existing.startedAt.getTime(),
        exitCode: input.exitCode,
        stdout: input.stdout === undefined ? undefined : keepLastBytes(input.stdout),
        stderr: input.stderr === undefined ? undefined : keepLastBytes(input.stderr)
      })
      .where(eq(runLogs.id, id))
      .returning()
      .get()
  })
}

export function listRecentRuns(db: ChronosDb, limit = 50): RunLog[] {
  return db
    .select()
    .from(runLogs)
    .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
    .limit(limit)
    .all()
}

export function listRunsForJob(db: ChronosDb, jobId: number, limit = 50): RunLog[] {
  return db
    .select()
    .from(runLogs)
    .where(eq(runLogs.jobId, jobId))
    .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
    .limit(limit)
    .all()
}

export function getLatestRun(db: ChronosDb, jobId: number): RunLog | undefined {
  return db
    .select()
    .from(runLogs)
    .where(eq(runLogs.jobId, jobId))
    .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
    .limit(1)
    .get()
}

/** Last `limit` COMPLETED runs for one job, most recent first (same order convention as
 *  getLatestRun/listRunsForJob above) — the renderer's pure sparkline builder reverses this to
 *  chronological (oldest-first, left-to-right) order itself. In-progress runs (result IS NULL) are
 *  excluded — a null duration would otherwise draw as a break in the line with no clear meaning. */
export function listRunDurationTrend(db: ChronosDb, jobId: number, limit: number): RunDurationPoint[] {
  return db
    .select({ durationMs: runLogs.durationMs, result: runLogs.result, startedAt: runLogs.startedAt })
    .from(runLogs)
    .where(and(eq(runLogs.jobId, jobId), isNotNull(runLogs.result)))
    .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
    .limit(limit)
    .all() as RunDurationPoint[]
}

/** v0.4.0 Run History search — all filters are optional/AND'd together; `searchText` alone expands
 *  to an OR across job name + stdout + stderr. Joined with jobs (innerJoin, matching
 *  dashboard.repository.ts's listFailuresSince) so RunLogWithJob.jobName is always present. */
export function searchRuns(db: ChronosDb, filters: RunSearchFilters): RunLogWithJob[] {
  const conditions = []
  if (filters.jobId !== undefined) conditions.push(eq(runLogs.jobId, filters.jobId))
  if (filters.result !== undefined) conditions.push(eq(runLogs.result, filters.result))
  if (filters.since !== undefined) conditions.push(gte(runLogs.startedAt, filters.since))
  if (filters.searchText) {
    const pattern = `%${escapeLikeTerm(filters.searchText)}%`
    conditions.push(
      sql`(${jobs.name} LIKE ${pattern} ESCAPE '\\' OR ${runLogs.stdout} LIKE ${pattern} ESCAPE '\\' OR ${runLogs.stderr} LIKE ${pattern} ESCAPE '\\')`
    )
  }
  return db
    .select({
      id: runLogs.id, jobId: runLogs.jobId, triggeredBy: runLogs.triggeredBy, result: runLogs.result,
      startedAt: runLogs.startedAt, endedAt: runLogs.endedAt, durationMs: runLogs.durationMs,
      exitCode: runLogs.exitCode, stdout: runLogs.stdout, stderr: runLogs.stderr, createdAt: runLogs.createdAt,
      jobName: jobs.name
    })
    .from(runLogs)
    .innerJoin(jobs, eq(jobs.id, runLogs.jobId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
    .limit(filters.limit)
    .all() as RunLogWithJob[]
}

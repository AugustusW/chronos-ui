// SPDX-License-Identifier: Apache-2.0
import { and, count, desc, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { jobs, runLogs } from './schema'

export interface FailureRow {
  jobId: number
  jobName: string
  result: 'failure' | 'timeout'
  exitCode: number | null
  startedAt: Date
  durationMs: number | null
}

/** v0.4.0 (native-notify.service.ts): a completed run's outcome, ANY result — unlike FailureRow
 *  above (pre-filtered to failures, for the Dashboard/tray display), this is the raw feed the native
 *  notifier's own pure `selectNewFailures` filters (schedule-triggered + failure/timeout, matching
 *  schedmgr/notify.go's notifyAfterRun) so that decision stays unit-testable in TS rather than baked
 *  into SQL. */
export interface RunOutcomeRow {
  jobId: number
  jobName: string
  triggeredBy: 'schedule' | 'manual'
  result: 'success' | 'failure' | 'timeout'
  exitCode: number | null
  startedAt: Date
}

const FAILED = ['failure', 'timeout'] as const

export function countsSince(db: ChronosDb, since: Date): { runs: number; succeeded: number; failed: number } {
  const row = db
    .select({
      runs: count(),
      succeeded: sql<number>`sum(case when ${runLogs.result} = 'success' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${runLogs.result} in ('failure','timeout') then 1 else 0 end)`
    })
    .from(runLogs)
    .where(and(gte(runLogs.startedAt, since), isNotNull(runLogs.result)))
    .get()
  return { runs: row?.runs ?? 0, succeeded: Number(row?.succeeded ?? 0), failed: Number(row?.failed ?? 0) }
}

export function listFailuresSince(db: ChronosDb, since: Date, limit: number): FailureRow[] {
  return db
    .select({
      jobId: runLogs.jobId, jobName: jobs.name, result: runLogs.result,
      exitCode: runLogs.exitCode, startedAt: runLogs.startedAt, durationMs: runLogs.durationMs
    })
    .from(runLogs)
    .innerJoin(jobs, eq(jobs.id, runLogs.jobId))
    .where(and(gte(runLogs.startedAt, since), inArray(runLogs.result, [...FAILED])))
    .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
    .limit(limit)
    .all() as FailureRow[]
}

export function countFailuresSince(db: ChronosDb, since: Date): number {
  const row = db.select({ n: count() }).from(runLogs)
    .where(and(gte(runLogs.startedAt, since), inArray(runLogs.result, [...FAILED]))).get()
  return row?.n ?? 0
}

export function countActiveJobs(db: ChronosDb): number {
  const row = db.select({ n: count() }).from(jobs)
    .where(and(eq(jobs.enabled, true), eq(jobs.adopted, true))).get()
  return row?.n ?? 0
}

/** Completed runs (any result) strictly newer than `since` — the native notifier's poll query.
 *  `gt` (not `gte`): the caller re-polls with `since` = the last-seen watermark, so a `>=` bound
 *  would re-fetch the exact boundary row it already processed on the previous tick. */
export function listRunOutcomesSince(db: ChronosDb, since: Date, limit: number): RunOutcomeRow[] {
  return db
    .select({
      jobId: runLogs.jobId, jobName: jobs.name, triggeredBy: runLogs.triggeredBy,
      result: runLogs.result, exitCode: runLogs.exitCode, startedAt: runLogs.startedAt
    })
    .from(runLogs)
    .innerJoin(jobs, eq(jobs.id, runLogs.jobId))
    .where(and(gt(runLogs.startedAt, since), isNotNull(runLogs.result)))
    .orderBy(runLogs.startedAt, runLogs.id)
    .limit(limit)
    .all() as RunOutcomeRow[]
}

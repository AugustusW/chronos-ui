// SPDX-License-Identifier: Apache-2.0
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
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

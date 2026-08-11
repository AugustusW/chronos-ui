// SPDX-License-Identifier: Apache-2.0
import { and, count, desc, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import type { PgDb } from './client'
import { jobs, runLogs } from './schema.pg'
import type { FailureRow, RunOutcomeRow } from './dashboard.repository'

const FAILED = ['failure', 'timeout'] as const

/** Postgres implementation of the dashboard repository (mirror of sqlite dashboard.repository.ts). */
export function createPgDashboardRepo(db: PgDb) {
  return {
    async countsSince(since: Date): Promise<{ runs: number; succeeded: number; failed: number }> {
      const [row] = await db
        .select({
          runs: count(),
          succeeded: sql<number>`sum(case when ${runLogs.result} = 'success' then 1 else 0 end)`,
          failed: sql<number>`sum(case when ${runLogs.result} in ('failure','timeout') then 1 else 0 end)`
        })
        .from(runLogs)
        .where(and(gte(runLogs.startedAt, since), isNotNull(runLogs.result)))
      return { runs: row?.runs ?? 0, succeeded: Number(row?.succeeded ?? 0), failed: Number(row?.failed ?? 0) }
    },
    async listFailuresSince(since: Date, limit: number): Promise<FailureRow[]> {
      return (await db
        .select({
          jobId: runLogs.jobId, jobName: jobs.name, result: runLogs.result,
          exitCode: runLogs.exitCode, startedAt: runLogs.startedAt, durationMs: runLogs.durationMs
        })
        .from(runLogs)
        .innerJoin(jobs, eq(jobs.id, runLogs.jobId))
        .where(and(gte(runLogs.startedAt, since), inArray(runLogs.result, [...FAILED])))
        .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
        .limit(limit)) as FailureRow[]
    },
    async countFailuresSince(since: Date): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(runLogs)
        .where(and(gte(runLogs.startedAt, since), inArray(runLogs.result, [...FAILED])))
      return row?.n ?? 0
    },
    async countActiveJobs(): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(jobs)
        .where(and(eq(jobs.enabled, true), eq(jobs.adopted, true)))
      return row?.n ?? 0
    },
    async listRunOutcomesSince(since: Date, limit: number): Promise<RunOutcomeRow[]> {
      return (await db
        .select({
          jobId: runLogs.jobId, jobName: jobs.name, triggeredBy: runLogs.triggeredBy,
          result: runLogs.result, exitCode: runLogs.exitCode, startedAt: runLogs.startedAt
        })
        .from(runLogs)
        .innerJoin(jobs, eq(jobs.id, runLogs.jobId))
        .where(and(gt(runLogs.startedAt, since), isNotNull(runLogs.result)))
        .orderBy(runLogs.startedAt, runLogs.id)
        .limit(limit)) as RunOutcomeRow[]
    }
  }
}

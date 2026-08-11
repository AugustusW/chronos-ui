// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { PgDb } from './client'
import { jobs, runLogs } from './schema.pg'
import type { RunLog } from './schema'
import { keepLastBytes } from './output'
import { escapeLikeTerm, type RunDurationPoint, type RunLogWithJob, type RunSearchFilters } from './runLogs.repository'

/** Postgres implementation of the run-logs repository (mirror of sqlite runLogs.repository.ts). */
export function createPgRunLogsRepo(db: PgDb) {
  return {
    async startRun(input: {
      jobId: number
      triggeredBy: 'schedule' | 'manual'
      startedAt?: Date
    }): Promise<RunLog> {
      const [row] = await db
        .insert(runLogs)
        .values({
          jobId: input.jobId,
          triggeredBy: input.triggeredBy,
          startedAt: input.startedAt ?? new Date()
        })
        .returning()
      return row as RunLog
    },
    async finishRun(
      id: number,
      input: {
        result: 'success' | 'failure' | 'timeout'
        endedAt?: Date
        exitCode?: number
        stdout?: string
        stderr?: string
      }
    ): Promise<RunLog | undefined> {
      // Atomic read-then-write: two pool checkouts (the prior SELECT + UPDATE) could interleave with
      // another writer; a single transaction pins them to one connection + one atomic unit (review #11).
      return db.transaction(async (tx) => {
        const [existing] = await tx.select().from(runLogs).where(eq(runLogs.id, id))
        if (!existing) return undefined
        const endedAt = input.endedAt ?? new Date()
        const [row] = await tx
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
        return row as RunLog | undefined
      })
    },
    async listRecent(limit = 50): Promise<RunLog[]> {
      return (await db
        .select()
        .from(runLogs)
        .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
        .limit(limit)) as RunLog[]
    },
    async listForJob(jobId: number, limit = 50): Promise<RunLog[]> {
      return (await db
        .select()
        .from(runLogs)
        .where(eq(runLogs.jobId, jobId))
        .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
        .limit(limit)) as RunLog[]
    },
    async getLatest(jobId: number): Promise<RunLog | undefined> {
      const [row] = await db
        .select()
        .from(runLogs)
        .where(eq(runLogs.jobId, jobId))
        .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
        .limit(1)
      return row as RunLog | undefined
    },
    /** Delete run_logs older than `cutoff`; returns rows removed (retention sweep, review #4). */
    async pruneOlderThan(cutoff: Date): Promise<number> {
      const res = await db.delete(runLogs).where(lt(runLogs.startedAt, cutoff))
      return res.rowCount ?? 0
    },
    /** Mirrors sqlite's listRunDurationTrend. */
    async listRunDurationTrend(jobId: number, limit: number): Promise<RunDurationPoint[]> {
      return (await db
        .select({ durationMs: runLogs.durationMs, result: runLogs.result, startedAt: runLogs.startedAt })
        .from(runLogs)
        .where(and(eq(runLogs.jobId, jobId), isNotNull(runLogs.result)))
        .orderBy(desc(runLogs.startedAt), desc(runLogs.id))
        .limit(limit)) as RunDurationPoint[]
    },
    /** Mirrors sqlite's searchRuns — ILIKE (not LIKE) for case-insensitive matching, since unlike
     *  sqlite's LIKE, Postgres's plain LIKE is case-sensitive. */
    async searchRuns(filters: RunSearchFilters): Promise<RunLogWithJob[]> {
      const conditions = []
      if (filters.jobId !== undefined) conditions.push(eq(runLogs.jobId, filters.jobId))
      if (filters.result !== undefined) conditions.push(eq(runLogs.result, filters.result))
      if (filters.since !== undefined) conditions.push(gte(runLogs.startedAt, filters.since))
      if (filters.searchText) {
        const pattern = `%${escapeLikeTerm(filters.searchText)}%`
        conditions.push(
          sql`(${jobs.name} ILIKE ${pattern} ESCAPE '\\' OR ${runLogs.stdout} ILIKE ${pattern} ESCAPE '\\' OR ${runLogs.stderr} ILIKE ${pattern} ESCAPE '\\')`
        )
      }
      return (await db
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
        .limit(filters.limit)) as RunLogWithJob[]
    }
  }
}

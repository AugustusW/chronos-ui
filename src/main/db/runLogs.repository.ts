// SPDX-License-Identifier: Apache-2.0
import { desc, eq, lt } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { runLogs, type RunLog } from './schema'
import { keepLastBytes } from './output'

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

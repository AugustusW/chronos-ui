// SPDX-License-Identifier: Apache-2.0
import { desc, eq } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { runLogs, type RunLog } from './schema'
import { keepLastBytes } from './output'

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
  const existing = db.select().from(runLogs).where(eq(runLogs.id, id)).get()
  if (!existing) return undefined
  const endedAt = input.endedAt ?? new Date()
  return db
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

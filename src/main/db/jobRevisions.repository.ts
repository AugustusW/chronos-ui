// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { jobRevisions, type JobRevision } from './schema'

export type RevisionSource = 'edit' | 'adopt' | 'unadopt' | 'external' | 'resolved'

/** Sources that describe the state of external drift, newest-first. Reading them as one sequence is
 *  what makes the history self-describing: an `external` with no `resolved` after it is a drift
 *  that is still standing, and that fact survives a restart — an in-memory flag would not. */
export const DRIFT_SOURCES = ['external', 'resolved'] as const satisfies readonly RevisionSource[]

export interface RecordRevisionInput {
  jobId: number
  source: RevisionSource
  changedFields: string[]
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** Injectable for tests and for backdating an externally-observed change; defaults to now. */
  changedAt?: Date
}

export function recordRevision(db: ChronosDb, input: RecordRevisionInput): JobRevision {
  return db
    .insert(jobRevisions)
    .values({
      jobId: input.jobId,
      source: input.source,
      changedFields: input.changedFields,
      before: input.before,
      after: input.after,
      ...(input.changedAt ? { changedAt: input.changedAt } : {})
    })
    .returning()
    .get()
}

/** Newest first. The id tiebreak matters: several revisions can share a millisecond (a batch
 *  edit, or a fast adopt→unadopt), and without it the UI order would be arbitrary. */
export function listRevisionsForJob(db: ChronosDb, jobId: number, limit = 50): JobRevision[] {
  return db
    .select()
    .from(jobRevisions)
    .where(eq(jobRevisions.jobId, jobId))
    .orderBy(desc(jobRevisions.changedAt), desc(jobRevisions.id))
    .limit(limit)
    .all()
}

/** Newest revision for a job, optionally restricted to one source. The `external` filter is what
 *  keeps drift de-duplicated: the same unresolved external edit is observed on every list(). */
export function getLatestRevision(
  db: ChronosDb,
  jobId: number,
  source?: RevisionSource | readonly RevisionSource[]
): JobRevision | undefined {
  // typeof narrows cleanly where Array.isArray does not for a readonly tuple.
  const bySource =
    source === undefined
      ? undefined
      : typeof source === 'string'
        ? eq(jobRevisions.source, source)
        : inArray(jobRevisions.source, [...source])
  const where = bySource ? and(eq(jobRevisions.jobId, jobId), bySource) : eq(jobRevisions.jobId, jobId)
  return db
    .select()
    .from(jobRevisions)
    .where(where)
    .orderBy(desc(jobRevisions.changedAt), desc(jobRevisions.id))
    .limit(1)
    .get()
}

// SPDX-License-Identifier: Apache-2.0
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PgDb } from './client'
import { jobRevisions } from './schema.pg'
import type { JobRevision } from './schema'
import type { RecordRevisionInput, RevisionSource } from './jobRevisions.repository'

/** Postgres implementation of the job-revisions repository (mirror of jobRevisions.repository.ts). */
export function createPgJobRevisionsRepo(db: PgDb) {
  return {
    async record(input: RecordRevisionInput): Promise<JobRevision> {
      const [row] = await db
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
      return row as JobRevision
    },
    async listForJob(jobId: number, limit = 50): Promise<JobRevision[]> {
      const rows = await db
        .select()
        .from(jobRevisions)
        .where(eq(jobRevisions.jobId, jobId))
        .orderBy(desc(jobRevisions.changedAt), desc(jobRevisions.id))
        .limit(limit)
      return rows as JobRevision[]
    },
    async getLatest(jobId: number, source?: RevisionSource | readonly RevisionSource[]): Promise<JobRevision | undefined> {
      // typeof narrows cleanly where Array.isArray does not for a readonly tuple.
      const bySource =
        source === undefined
          ? undefined
          : typeof source === 'string'
            ? eq(jobRevisions.source, source)
            : inArray(jobRevisions.source, [...source])
      const where = bySource ? and(eq(jobRevisions.jobId, jobId), bySource) : eq(jobRevisions.jobId, jobId)
      const [row] = await db
        .select()
        .from(jobRevisions)
        .where(where)
        .orderBy(desc(jobRevisions.changedAt), desc(jobRevisions.id))
        .limit(1)
      return row as JobRevision | undefined
    }
  }
}

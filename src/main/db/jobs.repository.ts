// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { jobs, type Job, type NewJob } from './schema'

export function createJob(db: ChronosDb, input: NewJob): Job {
  return db.insert(jobs).values(input).returning().get()
}

export function getJob(db: ChronosDb, id: number): Job | undefined {
  return db.select().from(jobs).where(eq(jobs.id, id)).get()
}

export function listJobs(
  db: ChronosDb,
  filter?: { enabled?: boolean; category?: string }
): Job[] {
  const conditions = []
  if (filter?.enabled !== undefined) conditions.push(eq(jobs.enabled, filter.enabled))
  if (filter?.category !== undefined) conditions.push(eq(jobs.category, filter.category))
  const where = conditions.length ? and(...conditions) : undefined
  // Stable, deterministic order (SQLite gives no order without ORDER BY).
  return db.select().from(jobs).where(where).orderBy(asc(jobs.id)).all()
}

export function updateJob(
  db: ChronosDb,
  id: number,
  patch: Partial<NewJob>
): Job | undefined {
  // updateJob is the sole writer of updatedAt (the schema has no $onUpdateFn — see schema.ts —
  // so setJobCachedRun does not bump it). Bump it here on every config change.
  return db
    .update(jobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(jobs.id, id))
    .returning()
    .get()
}

export function deleteJob(db: ChronosDb, id: number): void {
  db.delete(jobs).where(eq(jobs.id, id)).run()
}

export function setJobCachedRun(
  db: ChronosDb,
  id: number,
  data: { lastRunAt: Date; lastResult: 'success' | 'failure' | 'timeout' }
): void {
  db.update(jobs).set(data).where(eq(jobs.id, id)).run()
}

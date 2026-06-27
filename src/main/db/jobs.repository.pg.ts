// SPDX-License-Identifier: Apache-2.0
import { and, asc, eq } from 'drizzle-orm'
import type { PgDb } from './client'
import { jobs } from './schema.pg'
import type { Job, NewJob } from './schema'

/** Postgres implementation of the jobs repository (mirror of the sqlite jobs.repository.ts queries). */
export function createPgJobsRepo(db: PgDb) {
  return {
    async create(input: NewJob): Promise<Job> {
      // `input` is the canonical (sqlite-schema) NewJob; the pg columns are structurally identical
      // (the parity test guards this), drizzle's branded column types just need the cast hint.
      const [row] = await db.insert(jobs).values(input as typeof jobs.$inferInsert).returning()
      return row as Job
    },
    async get(id: number): Promise<Job | undefined> {
      const [row] = await db.select().from(jobs).where(eq(jobs.id, id))
      return row as Job | undefined
    },
    async list(filter?: { enabled?: boolean; category?: string }): Promise<Job[]> {
      const conditions = []
      if (filter?.enabled !== undefined) conditions.push(eq(jobs.enabled, filter.enabled))
      if (filter?.category !== undefined) conditions.push(eq(jobs.category, filter.category))
      const where = conditions.length ? and(...conditions) : undefined
      return (await db.select().from(jobs).where(where).orderBy(asc(jobs.id))) as Job[]
    },
    async update(id: number, patch: Partial<NewJob>): Promise<Job | undefined> {
      const set = { ...patch, updatedAt: new Date() } as Partial<typeof jobs.$inferInsert>
      const [row] = await db.update(jobs).set(set).where(eq(jobs.id, id)).returning()
      return row as Job | undefined
    },
    async remove(id: number): Promise<void> {
      await db.delete(jobs).where(eq(jobs.id, id))
    },
    async setCachedRun(
      id: number,
      data: { lastRunAt: Date; lastResult: 'success' | 'failure' | 'timeout' }
    ): Promise<void> {
      await db.update(jobs).set(data).where(eq(jobs.id, id))
    }
  }
}

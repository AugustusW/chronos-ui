import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import * as schema from '../../src/main/db/schema'

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/main/db/migrations' })
  return { db, sqlite }
}

describe('notify schema', () => {
  it('jobs has notifyOnFailure defaulting to false', () => {
    const { db } = freshDb()
    const job = db.insert(schema.jobs).values({
      name: 'j', source: 'native_cron', platform: 'darwin',
      scheduleExpr: '* * * * *', command: 'echo hi'
    }).returning().get()
    expect(job.notifyOnFailure).toBe(false)
  })

  it('notify_settings stores a singleton row', () => {
    const { db } = freshDb()
    db.insert(schema.notifySettings).values({ id: 1, enabled: true, chatId: '123', windowMin: 5 }).run()
    const row = db.select().from(schema.notifySettings).where(eq(schema.notifySettings.id, 1)).get()
    expect(row).toMatchObject({ enabled: true, chatId: '123', windowMin: 5 })
  })

  it('notify_outbox holds a pending failure and cascades on job delete', () => {
    const { db } = freshDb()
    const job = db.insert(schema.jobs).values({
      name: 'j', source: 'native_cron', platform: 'darwin', scheduleExpr: '* * * * *', command: 'x'
    }).returning().get()
    db.insert(schema.notifyOutbox).values({
      jobId: job.id, jobName: 'j', result: 'failure', exitCode: 1, occurredAt: new Date()
    }).run()
    expect(db.select().from(schema.notifyOutbox).all()).toHaveLength(1)
    db.delete(schema.jobs).where(eq(schema.jobs.id, job.id)).run()
    expect(db.select().from(schema.notifyOutbox).all()).toHaveLength(0) // FK cascade
  })
})

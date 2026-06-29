import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../src/main/db/schema'
import { createSqliteNotifySettingsRepo } from '../../src/main/db/notifySettings.repository'

function repo() {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/main/db/migrations' })
  return createSqliteNotifySettingsRepo(db)
}

describe('notifySettings repo', () => {
  it('get() returns defaults when unset', async () => {
    expect(await repo().get()).toMatchObject({ enabled: false, chatId: null, windowMin: 0 })
  })
  it('save() upserts the singleton and get() reads it back', async () => {
    const r = repo()
    await r.save({ enabled: true, chatId: '42', windowMin: 5 })
    expect(await r.get()).toMatchObject({ enabled: true, chatId: '42', windowMin: 5 })
    await r.save({ enabled: false, chatId: null, windowMin: 0 })
    expect(await r.get()).toMatchObject({ enabled: false, chatId: null, windowMin: 0 })
  })
})

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
    await r.save({ enabled: true, chatId: '42', windowMin: 5, includeStderr: false, nativeEnabled: true })
    expect(await r.get()).toMatchObject({ enabled: true, chatId: '42', windowMin: 5 })
    await r.save({ enabled: false, chatId: null, windowMin: 0, includeStderr: false, nativeEnabled: true })
    expect(await r.get()).toMatchObject({ enabled: false, chatId: null, windowMin: 0 })
  })

  // v0.4.0: native failure notifications default ON (no setup cost, unlike Telegram) and round-trip.
  it('nativeEnabled defaults to true (DB column default) even when unset', async () => {
    expect((await repo().get()).nativeEnabled).toBe(true)
  })
  it('nativeEnabled persists an explicit false and reads it back', async () => {
    const r = repo()
    await r.save({ enabled: false, chatId: null, windowMin: 0, includeStderr: false, nativeEnabled: false })
    expect((await r.get()).nativeEnabled).toBe(false)
  })
})

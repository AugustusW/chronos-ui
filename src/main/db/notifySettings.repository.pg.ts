// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm'
import type { PgDb } from './client'
import { notifySettings } from './schema.pg'
import type { NotifySettingsView, NotifySettingsInput, NotifySettingsRepo } from './notifySettings.repository'

const DEFAULT: NotifySettingsView = { enabled: false, chatId: null, windowMin: 0, updatedAt: null }

/** Postgres implementation of the notifySettings repository (mirror of the sqlite notifySettings.repository.ts). */
export function createPgNotifySettingsRepo(db: PgDb): NotifySettingsRepo {
  return {
    async get(): Promise<NotifySettingsView> {
      const [row] = await db.select().from(notifySettings).where(eq(notifySettings.id, 1))
      if (!row) return { ...DEFAULT }
      return { enabled: row.enabled, chatId: row.chatId, windowMin: row.windowMin, updatedAt: row.updatedAt }
    },
    async save(input: NotifySettingsInput): Promise<NotifySettingsView> {
      await db.insert(notifySettings)
        .values({ id: 1, enabled: input.enabled, chatId: input.chatId, windowMin: input.windowMin, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: notifySettings.id,
          set: { enabled: input.enabled, chatId: input.chatId, windowMin: input.windowMin, updatedAt: new Date() }
        })
      return this.get()
    }
  }
}

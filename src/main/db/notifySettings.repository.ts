// SPDX-License-Identifier: Apache-2.0
import { eq } from 'drizzle-orm'
import type { ChronosDb } from './client'
import { notifySettings } from './schema'

export type NotifySettingsView = { enabled: boolean; chatId: string | null; windowMin: number; updatedAt: Date | null }
export type NotifySettingsInput = { enabled: boolean; chatId: string | null; windowMin: number }

export interface NotifySettingsRepo {
  get(): Promise<NotifySettingsView>
  save(input: NotifySettingsInput): Promise<NotifySettingsView>
}

const DEFAULT: NotifySettingsView = { enabled: false, chatId: null, windowMin: 0, updatedAt: null }

export function createSqliteNotifySettingsRepo(db: ChronosDb): NotifySettingsRepo {
  return {
    async get(): Promise<NotifySettingsView> {
      const row = db.select().from(notifySettings).where(eq(notifySettings.id, 1)).get()
      if (!row) return { ...DEFAULT }
      return { enabled: row.enabled, chatId: row.chatId, windowMin: row.windowMin, updatedAt: row.updatedAt }
    },
    async save(input: NotifySettingsInput): Promise<NotifySettingsView> {
      db.insert(notifySettings)
        .values({ id: 1, enabled: input.enabled, chatId: input.chatId, windowMin: input.windowMin, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: notifySettings.id,
          set: { enabled: input.enabled, chatId: input.chatId, windowMin: input.windowMin, updatedAt: new Date() }
        })
        .run()
      return this.get()
    }
  }
}

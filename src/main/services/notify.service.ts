// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { Repositories } from '../db/repositories'
import type { FlushScheduler } from './notify-flush-launchd'
import { NOTIFY_TOKEN_FILE, writeNotifyToken } from './notify-secret'

export type NotifySettingsDTO = { enabled: boolean; chatId: string | null; windowMin: number; tokenSet: boolean }
export type NotifySaveInput = { enabled: boolean; chatId: string | null; windowMin: number; token?: string }
export type SaveResult = { ok: boolean; settings?: NotifySettingsDTO; flushWarning?: string }

export interface NotifyServiceDeps {
  repos: Repositories
  /** Installs/removes ChronosUI's own notify-flush entry. Platform-specific impl (launchd on macOS,
   *  crontab/Task Scheduler adapter elsewhere) is injected by bootstrap. */
  flushScheduler: FlushScheduler
  schedmgrPath: string
  schedmgrDescriptor: string
  secretDir: string
  fetchFn: typeof fetch
  spawnFlush: (path: string, args: string[]) => Promise<void>
}

export interface NotifyService {
  getSettings(): Promise<NotifySettingsDTO>
  saveSettings(input: NotifySaveInput): Promise<SaveResult>
  testSend(): Promise<{ ok: boolean; error?: string }>
}

const TELEGRAM_BASE = 'https://api.telegram.org'

export function createNotifyService(deps: NotifyServiceDeps): NotifyService {
  const tokenPath = join(deps.secretDir, NOTIFY_TOKEN_FILE)
  const tokenSet = (): boolean => existsSync(tokenPath)
  const readToken = (): string | null => {
    try { const t = readFileSync(tokenPath, 'utf8').trim(); return t || null } catch { return null }
  }
  const toDTO = (s: { enabled: boolean; chatId: string | null; windowMin: number }): NotifySettingsDTO =>
    ({ enabled: s.enabled, chatId: s.chatId, windowMin: s.windowMin, tokenSet: tokenSet() })

  return {
    async getSettings() {
      return toDTO(await deps.repos.notifySettings.get())
    },

    async saveSettings(input) {
      // Read the previous state BEFORE persisting so the pre-save drain can run while the DB
      // still holds the old enabled/chatId and the old token file is still in place.
      const prev = await deps.repos.notifySettings.get()
      const wasBatched = prev.enabled && prev.windowMin >= 1

      // Flush-entry lifecycle:
      //   1. Pre-save drain (best-effort) — flush any pending outbox rows using the OLD state so
      //      they are actually sent before the new (possibly disabling) state is persisted.
      //      Without this, flushOutbox early-returns on enabled=false / empty chatId, stranding rows.
      //   2. Write the new token (if provided).
      //   3. Persist the new settings.
      //   4. Install or remove the flush cron entry to match the new state.
      let flushWarning: string | undefined
      if (wasBatched) {
        try {
          await deps.spawnFlush(deps.schedmgrPath, ['notify-flush', '--db', deps.schedmgrDescriptor])
        } catch (e) {
          flushWarning = (e as Error).message
        }
      }

      if (input.token !== undefined && input.token !== '') writeNotifyToken(deps.secretDir, input.token)
      const saved = await deps.repos.notifySettings.save({ enabled: input.enabled, chatId: input.chatId, windowMin: input.windowMin })

      const wantFlush = input.enabled && input.windowMin >= 1
      try {
        const w = wantFlush ? await deps.flushScheduler.install(input.windowMin) : await deps.flushScheduler.remove()
        if (!w.ok) {
          const reason = w.reason === 'drift' ? 'flush schedule not updated (scheduler changed externally)' : `flush schedule update failed: ${'error' in w ? w.error : w.reason}`
          flushWarning = flushWarning ? `${flushWarning}; ${reason}` : reason
        }
      } catch (e) {
        const msg = (e as Error).message
        flushWarning = flushWarning ? `${flushWarning}; ${msg}` : msg
      }
      return { ok: true, settings: toDTO(saved), flushWarning }
    },

    async testSend() {
      const token = readToken()
      if (!token) return { ok: false, error: 'No bot token saved' }
      const s = await deps.repos.notifySettings.get()
      if (!s.chatId) return { ok: false, error: 'No chat id saved' }
      try {
        const body = new URLSearchParams({ chat_id: s.chatId, text: '✅ ChronosUI test message' })
        const resp = await deps.fetchFn(`${TELEGRAM_BASE}/bot${token}/sendMessage`, { method: 'POST', body })
        if (!resp.ok) return { ok: false, error: `Telegram ${resp.status}: ${(await resp.text()).slice(0, 200)}` }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  }
}

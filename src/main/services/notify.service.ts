// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { Repositories } from '../db/repositories'
import type { FlushScheduler } from './notify-flush-launchd'
import { NOTIFY_TOKEN_FILE, writeNotifyToken } from './notify-secret'
import { isNotifyTokenFormat, isChatIdFormat } from '../../shared/notify-validation'
import { NOTIFY_TOKEN_SERVICE, keychainWriteSupported, keychainStore, keychainRead, keychainDelete, type ExecFn } from './notify-keychain'

/** Where the bot token currently lives. 'keychain' = encrypted at rest in the OS keychain (macOS /
 *  Linux); 'file' = a 0600 plaintext file (Windows, or a keychain-write failure) — surfaced so the UI
 *  can warn the user it is unencrypted. */
export type TokenStorage = 'keychain' | 'file'
export type NotifySettingsDTO = { enabled: boolean; chatId: string | null; windowMin: number; tokenSet: boolean; tokenStorage: TokenStorage | null }
export type NotifySaveInput = { enabled: boolean; chatId: string | null; windowMin: number; token?: string }
export type SaveResult = { ok: boolean; settings?: NotifySettingsDTO; flushWarning?: string }

const KEYCHAIN_ACCOUNT = 'chronos-ui'

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
  /** Host platform — selects keychain write support (mirrors the Go reader). */
  platform: NodeJS.Platform
  /** Runs a keychain CLI (security / secret-tool); injected so tests never touch the real keychain. */
  execKeychain: ExecFn
  /** Where the "token stored unencrypted" warning goes (defaults to stderr). */
  logWarn?: (msg: string) => void
}

export interface NotifyService {
  getSettings(): Promise<NotifySettingsDTO>
  saveSettings(input: NotifySaveInput): Promise<SaveResult>
  testSend(): Promise<{ ok: boolean; error?: string }>
}

const TELEGRAM_BASE = 'https://api.telegram.org'

export function createNotifyService(deps: NotifyServiceDeps): NotifyService {
  const tokenPath = join(deps.secretDir, NOTIFY_TOKEN_FILE)
  const warn = deps.logWarn ?? ((m: string): void => { process.stderr.write(`chronos-ui: ${m}\n`) })
  const fileToken = (): string | null => {
    try { const t = readFileSync(tokenPath, 'utf8').trim(); return t || null } catch { return null }
  }

  // Token persistence is keychain-first (mirroring the Go reader in schedmgr/secret.go), with the
  // 0600 file as the fallback on Windows / a keychain-write failure.
  const storeToken = async (token: string): Promise<void> => {
    if (keychainWriteSupported(deps.platform)) {
      const stored = await keychainStore(deps.execKeychain, deps.platform, NOTIFY_TOKEN_SERVICE, KEYCHAIN_ACCOUNT, token)
      if (stored) {
        // Migrate away from any earlier plaintext file so the token no longer lives on disk in clear.
        try { rmSync(tokenPath) } catch { /* no prior file */ }
        return
      }
      // Keychain write failed → fall back to the file. First clear any PRIOR keychain item, otherwise a
      // stale token from an earlier successful write would shadow the new file token — both readToken()
      // here and the Go schedmgr read keychain-first, so they'd serve the old token (code review #2).
      await keychainDelete(deps.execKeychain, deps.platform, NOTIFY_TOKEN_SERVICE)
      warn(`keychain store failed; storing the Telegram bot token UNENCRYPTED at ${tokenPath}`)
    } else {
      warn(`keychain write unsupported on ${deps.platform}; storing the Telegram bot token UNENCRYPTED at ${tokenPath}`)
    }
    writeNotifyToken(deps.secretDir, token)
  }
  const readToken = async (): Promise<string | null> => {
    if (keychainWriteSupported(deps.platform)) {
      const kc = await keychainRead(deps.execKeychain, deps.platform, NOTIFY_TOKEN_SERVICE)
      if (kc) return kc
    }
    return fileToken()
  }
  const tokenStorage = async (): Promise<TokenStorage | null> => {
    if (keychainWriteSupported(deps.platform)) {
      const kc = await keychainRead(deps.execKeychain, deps.platform, NOTIFY_TOKEN_SERVICE)
      if (kc) return 'keychain'
    }
    return existsSync(tokenPath) ? 'file' : null
  }
  const toDTO = async (s: { enabled: boolean; chatId: string | null; windowMin: number }): Promise<NotifySettingsDTO> => {
    const storage = await tokenStorage()
    return { enabled: s.enabled, chatId: s.chatId, windowMin: s.windowMin, tokenSet: storage !== null, tokenStorage: storage }
  }

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

      if (input.token !== undefined && input.token !== '') await storeToken(input.token)
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
      return { ok: true, settings: await toDTO(saved), flushWarning }
    },

    async testSend() {
      const token = await readToken()
      if (!token) return { ok: false, error: 'No bot token saved' }
      // The token is read from disk and interpolated into the API URL path below — re-validate its
      // format here so a tampered .secret file can't reshape the request, keeping the same
      // defense-in-depth invariant as the IPC + Go boundaries (code review #2).
      if (!isNotifyTokenFormat(token)) return { ok: false, error: 'Saved bot token has an invalid format' }
      const s = await deps.repos.notifySettings.get()
      if (!s.chatId) return { ok: false, error: 'No chat id saved' }
      if (!isChatIdFormat(s.chatId)) return { ok: false, error: 'Saved chat id has an invalid format' }
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

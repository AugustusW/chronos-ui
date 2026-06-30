// SPDX-License-Identifier: Apache-2.0
import { reactive } from 'vue'

export function createNotifyStore() {
  const state = reactive({
    enabled: false,
    chatId: '' as string,
    windowMin: 0,
    includeStderr: false, // opt-in: include failed-job stderr tail in immediate alerts
    tokenSet: false,
    tokenStorage: null as 'keychain' | 'file' | null, // where the saved token lives (file = unencrypted)
    token: '' as string, // write-only; cleared after save
    saving: false,
    testing: false,
    testResult: null as string | null,
    error: null as string | null
  })

  async function load(): Promise<void> {
    const s = await window.chronos.getNotifySettings()
    state.enabled = s.enabled
    state.chatId = s.chatId ?? ''
    state.windowMin = s.windowMin
    state.includeStderr = s.includeStderr
    state.tokenSet = s.tokenSet
    state.tokenStorage = s.tokenStorage
  }

  async function save(): Promise<void> {
    state.saving = true
    state.error = null
    try {
      const r = await window.chronos.saveNotifySettings({
        enabled: state.enabled,
        chatId: state.chatId || null,
        windowMin: state.windowMin,
        includeStderr: state.includeStderr,
        token: state.token ? state.token : undefined
      })
      if (!r.ok) {
        state.error = 'Save failed'
      } else {
        state.token = ''
        if (r.settings) { state.tokenSet = r.settings.tokenSet; state.tokenStorage = r.settings.tokenStorage }
        if (r.flushWarning) state.error = r.flushWarning
      }
    } finally {
      state.saving = false
    }
  }

  async function test(): Promise<void> {
    state.testing = true
    state.testResult = null
    try {
      const r = await window.chronos.testNotify()
      state.testResult = r.ok ? '✅ Test message sent' : `❌ ${r.error ?? 'Test failed'}`
    } finally {
      state.testing = false
    }
  }

  return reactive({
    get enabled() { return state.enabled },
    set enabled(v: boolean) { state.enabled = v },
    get chatId() { return state.chatId },
    set chatId(v: string) { state.chatId = v },
    get windowMin() { return state.windowMin },
    set windowMin(v: number) { state.windowMin = v },
    get includeStderr() { return state.includeStderr },
    set includeStderr(v: boolean) { state.includeStderr = v },
    get token() { return state.token },
    set token(v: string) { state.token = v },
    get tokenSet() { return state.tokenSet },
    get tokenStorage() { return state.tokenStorage },
    get saving() { return state.saving },
    get testing() { return state.testing },
    get testResult() { return state.testResult },
    get error() { return state.error },
    load, save, test
  })
}

let singleton: ReturnType<typeof createNotifyStore> | null = null
export function useNotifyStore() { return (singleton ??= createNotifyStore()) }
/** Reset the module-level singleton — for test isolation only. */
export function _resetNotifySingleton(): void { singleton = null }

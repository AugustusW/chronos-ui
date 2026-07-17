// SPDX-License-Identifier: Apache-2.0
import { reactive } from 'vue'
import type { PgDsnParts, PgStatus, TestConnectionResult, PgSaveSwitchResult } from '../../../shared/ipc-contract'

/** SSL mode is a free-form string on the wire (backend-switch.ts validates against the allowed
 *  enum), but the settings UI only ever offers 3 choices (design mockup) — 'disable' is the safe
 *  default for a first-time connection attempt (matches ipc.ts's PG_SSLMODES default expectation). */
const DEFAULT_FIELDS: PgDsnParts = { host: '', port: 5432, database: '', user: '', password: '', sslmode: 'disable' }

export function createDbSettingsStore() {
  const state = reactive({
    status: { activeBackend: 'sqlite', keychainAvailable: true } as PgStatus,
    selectedBackend: 'sqlite' as 'sqlite' | 'postgres',
    fields: { ...DEFAULT_FIELDS } as PgDsnParts,
    copyData: true,
    testResult: null as TestConnectionResult | null,
    testing: false,
    switching: false,
    error: null as string | null
  })

  async function load(): Promise<void> {
    const s = await window.chronos.pgGetStatus()
    state.status = s
    // Segmented control reflects the backend THIS process actually booted against, not whatever
    // was left selected from a prior (never-saved) form interaction.
    state.selectedBackend = s.activeBackend
  }

  /** Switching the segmented control discards any in-progress probe/error from the previous
   *  choice — a stale "Connection OK" for postgres must not linger after flipping to sqlite. */
  function selectBackend(b: 'sqlite' | 'postgres'): void {
    state.selectedBackend = b
    state.testResult = null
    state.error = null
  }

  async function test(): Promise<void> {
    state.testing = true
    state.testResult = null
    try {
      state.testResult = await window.chronos.pgTestConnection(state.fields)
    } finally {
      state.testing = false
    }
  }

  async function saveSwitch(): Promise<PgSaveSwitchResult> {
    state.switching = true
    state.error = null
    try {
      const r = await window.chronos.pgSaveSwitch({
        fields: state.fields,
        copyData: state.copyData,
        targetBackend: state.selectedBackend
      })
      if (!r.ok) state.error = r.error
      return r
    } finally {
      state.switching = false
    }
  }

  return reactive({
    get status() { return state.status },
    get selectedBackend() { return state.selectedBackend },
    get fields() { return state.fields },
    get copyData() { return state.copyData },
    set copyData(v: boolean) { state.copyData = v },
    get testResult() { return state.testResult },
    get testing() { return state.testing },
    get switching() { return state.switching },
    get error() { return state.error },
    load, selectBackend, test, saveSwitch
  })
}

let singleton: ReturnType<typeof createDbSettingsStore> | null = null
export function useDbSettingsStore() { return (singleton ??= createDbSettingsStore()) }
/** Reset the module-level singleton — for test isolation only. */
export function _resetDbSettingsSingleton(): void { singleton = null }

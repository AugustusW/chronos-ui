// SPDX-License-Identifier: Apache-2.0
import { reactive } from 'vue'
import type { DashboardSummary, RunEvent } from '../../../shared/ipc-contract'
import { api } from '../ipc/api'

// Reactive composable store (same pattern as schedule.store.ts). Pinia escape-hatch: adopt only if
// this grows past one module.
export function createDashboardStore() {
  const state = reactive({
    summary: null as DashboardSummary | null,
    loading: false,
    error: null as string | null
  })
  // In-flight guard: a background refresh (RunEvent-triggered or overlapping poll) that lands
  // while one is already running joins the existing call instead of firing a second IPC round-trip.
  let inFlight: Promise<void> | null = null

  function refresh(): Promise<void> {
    if (inFlight) return inFlight
    // Only the first load (no summary yet) shows the skeleton — a background refresh must not
    // flash it over an already-rendered dashboard (MUST FIX #1).
    const isFirstLoad = state.summary === null
    if (isFirstLoad) state.loading = true
    state.error = null
    inFlight = (async () => {
      try {
        state.summary = await api.dashboardSummary()
      } catch (err) {
        state.error = err instanceof Error ? err.message : 'Dashboard load failed'
      } finally {
        state.loading = false
        inFlight = null
      }
    })()
    return inFlight
  }

  function applyRunEvent(e: RunEvent): void {
    if (e.kind === 'finished' || e.kind === 'jobsChanged') void refresh()
    // 'started' / 'output' carry no data the dashboard summary reflects — no-op.
  }

  return reactive({
    get summary() { return state.summary },
    get loading() { return state.loading },
    get error() { return state.error },
    refresh, applyRunEvent
  })
}

let singleton: ReturnType<typeof createDashboardStore> | null = null
export function useDashboardStore() { return (singleton ??= createDashboardStore()) }
/** Reset the module-level singleton — for test isolation only. */
export function _resetSingleton(): void { singleton = null }

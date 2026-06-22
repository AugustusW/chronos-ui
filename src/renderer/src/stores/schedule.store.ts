// SPDX-License-Identifier: Apache-2.0
import { reactive, computed } from 'vue'
import type { JobListItem, ReconcileResult, RunEvent } from '../../../shared/ipc-contract'

/** Maximum number of finished-run buffers retained in liveOutput. Running runs are never evicted. */
const LIVE_OUTPUT_MAX = 50

// Reactive composable store (design §3). Pinia escape-hatch: adopt only if this grows past one module.
export function createScheduleStore() {
  const state = reactive({
    items: [] as JobListItem[],
    categoryFilter: 'All' as string,
    selectMode: false,
    selectedIds: new Set<number>(),
    runningRuns: new Map<number, number>(), // jobId → runId
    liveOutput: new Map<number, { stdout: string; stderr: string }>() // runId → { stdout, stderr }
  })

  async function refresh(): Promise<void> {
    const r: ReconcileResult = await window.chronos.listJobs()
    state.items = r.items
  }
  const categories = computed<string[]>(() => {
    const set = new Set<string>()
    for (const it of state.items) if (it.job?.category) set.add(it.job.category)
    return [...set].sort()
  })
  const visibleGroups = computed(() => {
    const groups = new Map<string, JobListItem[]>()
    for (const it of state.items) {
      const cat = it.status === 'unmanaged' ? 'found in crontab' : it.job?.category ?? 'uncategorized'
      if (state.categoryFilter !== 'All' && cat !== state.categoryFilter) continue
      ;(groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(it)
    }
    return [...groups.entries()].map(([category, items]) => ({ category, items }))
  })
  function setCategory(c: string): void { state.categoryFilter = c }
  function toggleSelect(id: number): void {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id)
    else state.selectedIds.add(id)
  }
  function applyRunEvent(e: RunEvent): void {
    if (e.kind === 'started') {
      state.runningRuns.set(e.jobId, e.runId)
      state.liveOutput.set(e.runId, { stdout: '', stderr: '' })
      // Evict oldest finished entries when the map exceeds the bound.
      // Running runs (present in runningRuns values) are never evicted.
      if (state.liveOutput.size > LIVE_OUTPUT_MAX) {
        const activeRunIds = new Set(state.runningRuns.values())
        for (const [runId] of state.liveOutput) {
          if (state.liveOutput.size <= LIVE_OUTPUT_MAX) break
          if (!activeRunIds.has(runId)) state.liveOutput.delete(runId)
        }
      }
    } else if (e.kind === 'output') {
      const buf = state.liveOutput.get(e.runId) ?? { stdout: '', stderr: '' }
      state.liveOutput.set(e.runId, { ...buf, [e.stream]: buf[e.stream] + e.chunk })
    } else if (e.kind === 'finished') {
      for (const [jobId, runId] of state.runningRuns) if (runId === e.runId) state.runningRuns.delete(jobId)
      // liveOutput is intentionally NOT cleared so the terminal can show final output until view reloads
    } else if (e.kind === 'jobsChanged') void refresh()
  }

  return reactive({
    get items() { return state.items },
    get categoryFilter() { return state.categoryFilter },
    get selectMode() { return state.selectMode },
    set selectMode(v: boolean) { state.selectMode = v },
    get selectedIds() { return state.selectedIds },
    get runningRuns() { return state.runningRuns },
    get liveOutput() { return state.liveOutput },
    categories, visibleGroups,
    refresh, setCategory, toggleSelect, applyRunEvent
  })
}

let singleton: ReturnType<typeof createScheduleStore> | null = null
export function useScheduleStore() { return (singleton ??= createScheduleStore()) }
/** Reset the module-level singleton — for test isolation only. */
export function _resetSingleton(): void { singleton = null }

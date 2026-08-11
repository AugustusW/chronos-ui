// SPDX-License-Identifier: Apache-2.0
import { reactive } from 'vue'
import type { RunLogWithJob } from '../../../shared/ipc-contract'
import { RUN_SEARCH_PAGE_SIZE } from '../../../shared/dashboard-limits'
import { resolveDateRangePreset, type DateRangePreset } from '../lib/format'
import { api } from '../ipc/api'

export interface RunHistoryFilters {
  jobId: number | null
  result: 'success' | 'failure' | 'timeout' | null
  datePreset: DateRangePreset
  searchText: string
}

const DEFAULT_FILTERS: RunHistoryFilters = { jobId: null, result: null, datePreset: 'all', searchText: '' }
// Free-text search re-queries on every keystroke otherwise; other filters (job/result/date preset)
// are discrete select/button changes that don't need debouncing.
const SEARCH_DEBOUNCE_MS = 300

export function createRunHistoryStore() {
  const state = reactive({
    runs: [] as RunLogWithJob[],
    loading: false,
    loadingMore: false,
    error: null as string | null,
    filters: { ...DEFAULT_FILTERS } as RunHistoryFilters,
    limit: RUN_SEARCH_PAGE_SIZE,
    // Whether the last fetch came back exactly at `limit` — the cheap "there might be more" signal
    // this app already uses elsewhere (e.g. DashboardView's failuresTotal > DASHBOARD_FAILURES_LIMIT),
    // not a true total count (searchRuns intentionally doesn't compute one — see repo query doc).
    hasMore: false
  })

  let searchDebounce: ReturnType<typeof setTimeout> | undefined
  // "Latest request wins" — unlike dashboard.store.ts's refresh() (which always re-fetches the SAME
  // thing, so overlapping calls can just dedupe onto one in-flight promise), THIS store's queries
  // change shape as filters change: two rapid filter clicks fire two DIFFERENT searchRuns() calls,
  // and network/IPC timing gives no guarantee the second resolves after the first. A monotonic
  // sequence number lets a request recognize it's been superseded and discard its own result instead
  // of clobbering newer (correct) state with a stale (wrong-filter) response.
  let requestSeq = 0

  function fetchRuns(limit: number): Promise<RunLogWithJob[]> {
    return api.searchRuns({
      jobId: state.filters.jobId ?? undefined,
      result: state.filters.result ?? undefined,
      since: resolveDateRangePreset(state.filters.datePreset),
      searchText: state.filters.searchText || undefined,
      limit
    })
  }

  async function refresh(): Promise<void> {
    const seq = ++requestSeq
    state.loading = true
    // A fresh refresh() (new filters) supersedes any "load more" page in flight — without this, a
    // loadMore() superseded by a filter change would never clear loadingMore itself (its own guarded
    // finally is skipped, and refresh() otherwise never touches this flag).
    state.loadingMore = false
    state.error = null
    state.limit = RUN_SEARCH_PAGE_SIZE
    try {
      const rows = await fetchRuns(state.limit)
      if (seq !== requestSeq) return // superseded by a newer refresh()/loadMore() — discard
      state.runs = rows
      state.hasMore = rows.length === state.limit
    } catch (err) {
      if (seq !== requestSeq) return
      state.error = err instanceof Error ? err.message : String(err)
    } finally {
      if (seq === requestSeq) state.loading = false
    }
  }

  // Simple "load 50 more": re-queries with a bigger limit rather than a cursor/offset — the repo
  // pattern makes this trivial (searchRuns already takes a limit), and a desktop Run History view
  // doesn't need true cursor-stable pagination (a run landing between loads shifting the DESC window
  // by one row is a cosmetic, self-correcting nit, not a data-loss risk — see PR discussion for why
  // this was deliberately kept simple rather than adding an offset/cursor param).
  async function loadMore(): Promise<void> {
    if (state.loadingMore || !state.hasMore) return
    const seq = ++requestSeq
    state.loadingMore = true
    try {
      const nextLimit = state.limit + RUN_SEARCH_PAGE_SIZE
      const rows = await fetchRuns(nextLimit)
      if (seq !== requestSeq) return // e.g. a filter changed while this page was loading
      state.runs = rows
      state.limit = nextLimit
      state.hasMore = rows.length === nextLimit
    } catch (err) {
      if (seq !== requestSeq) return
      state.error = err instanceof Error ? err.message : String(err)
    } finally {
      if (seq === requestSeq) state.loadingMore = false
    }
  }

  /** Job / result / date-preset filters — discrete changes, refresh immediately. */
  function setFilters(patch: Partial<Omit<RunHistoryFilters, 'searchText'>>): void {
    Object.assign(state.filters, patch)
    void refresh()
  }

  /** Free-text search — updates the bound input immediately but debounces the actual refetch. */
  function setSearchText(text: string): void {
    state.filters.searchText = text
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => { void refresh() }, SEARCH_DEBOUNCE_MS)
  }

  function clearFilters(): void {
    if (searchDebounce) clearTimeout(searchDebounce)
    state.filters = { ...DEFAULT_FILTERS }
    void refresh()
  }

  return reactive({
    get runs() { return state.runs },
    get loading() { return state.loading },
    get loadingMore() { return state.loadingMore },
    get error() { return state.error },
    get filters() { return state.filters },
    get hasMore() { return state.hasMore },
    refresh, loadMore, setFilters, setSearchText, clearFilters
  })
}

let singleton: ReturnType<typeof createRunHistoryStore> | null = null
export function useRunHistoryStore() { return (singleton ??= createRunHistoryStore()) }
/** Reset the module-level singleton — for test isolation only. */
export function _resetRunHistorySingleton(): void { singleton = null }

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const searchRuns = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
beforeEach(() => { (globalThis as any).window = { chronos: { searchRuns } } })

import { createRunHistoryStore } from '../../src/renderer/src/stores/runHistory.store'
import { RUN_SEARCH_PAGE_SIZE } from '../../src/shared/dashboard-limits'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function rows(n: number): Array<{ id: number; jobId: number; jobName: string; triggeredBy: string; result: string; startedAt: number; endedAt: number; durationMs: number; exitCode: number; stdout: string; stderr: string; createdAt: number }> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, jobId: 1, jobName: 'Job', triggeredBy: 'schedule', result: 'success',
    startedAt: i, endedAt: i, durationMs: 100, exitCode: 0, stdout: '', stderr: '', createdAt: i
  }))
}

describe('runHistory store — refresh()', () => {
  beforeEach(() => searchRuns.mockReset())

  it('fetches with all-time defaults on first refresh', async () => {
    searchRuns.mockResolvedValue([])
    const s = createRunHistoryStore()
    await s.refresh()
    expect(searchRuns).toHaveBeenCalledWith({ jobId: undefined, result: undefined, since: undefined, searchText: undefined, limit: RUN_SEARCH_PAGE_SIZE })
  })

  it('toggles loading true → false around the fetch', async () => {
    searchRuns.mockResolvedValue([])
    const s = createRunHistoryStore()
    expect(s.loading).toBe(false)
    const p = s.refresh()
    expect(s.loading).toBe(true)
    await p
    expect(s.loading).toBe(false)
  })

  it('sets hasMore=true only when the result count equals the page size', async () => {
    searchRuns.mockResolvedValueOnce(rows(RUN_SEARCH_PAGE_SIZE))
    const s = createRunHistoryStore()
    await s.refresh()
    expect(s.hasMore).toBe(true)

    searchRuns.mockResolvedValueOnce(rows(3))
    await s.refresh()
    expect(s.hasMore).toBe(false)
  })

  it('records an error and clears loading on failure', async () => {
    // mockRejectedValueOnce (not the persistent mockRejectedValue) — see git history / PR
    // discussion: the persistent variant combined with this describe block's beforeEach-driven
    // mockReset() triggered a false "unhandled rejection" failure in this vitest version; the
    // one-shot variant sidesteps it (and is the more precise expression of intent here anyway —
    // this test only ever expects a single searchRuns() call).
    searchRuns.mockRejectedValueOnce(new Error('IPC failure'))
    const s = createRunHistoryStore()
    await s.refresh()
    expect(s.error).toBe('IPC failure')
    expect(s.loading).toBe(false)
  })

  it('a stale (superseded) response is discarded — the store reflects the LATEST request, not whichever resolves last', async () => {
    const s = createRunHistoryStore()
    let resolveFirst!: (v: unknown[]) => void
    let resolveSecond!: (v: unknown[]) => void
    searchRuns.mockReturnValueOnce(new Promise((res) => { resolveFirst = res }))
    const p1 = s.refresh() // e.g. triggered by clicking "7 days"
    searchRuns.mockReturnValueOnce(new Promise((res) => { resolveSecond = res }))
    const p2 = s.refresh() // then immediately "30 days" before the first resolved

    // Second (newer) resolves FIRST — should win.
    resolveSecond(rows(2))
    await p2
    expect(s.runs).toHaveLength(2)

    // First (older, superseded) resolves LAST — must NOT clobber the newer result.
    resolveFirst(rows(9))
    await p1
    expect(s.runs).toHaveLength(2)
  })
})

describe('runHistory store — setFilters', () => {
  beforeEach(() => searchRuns.mockReset())

  it('jobId/result/datePreset changes refresh immediately (no debounce)', async () => {
    searchRuns.mockResolvedValue([])
    const s = createRunHistoryStore()
    await s.refresh()
    searchRuns.mockClear()

    s.setFilters({ jobId: 5 })
    expect(searchRuns).toHaveBeenCalledTimes(1)
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ jobId: 5 }))
  })

  it('datePreset resolves to a since bound (not passed through as a preset string)', async () => {
    searchRuns.mockResolvedValue([])
    const s = createRunHistoryStore()
    let got: { since?: number } = {}
    searchRuns.mockImplementation(async (f: { since?: number }) => { got = f; return [] })
    s.setFilters({ datePreset: 'today' })
    await flush()
    expect(typeof got.since).toBe('number')
  })

  it("datePreset 'all' omits since entirely", async () => {
    searchRuns.mockResolvedValue([])
    const s = createRunHistoryStore()
    let got: { since?: number } = { since: 123 }
    searchRuns.mockImplementation(async (f: { since?: number }) => { got = f; return [] })
    s.setFilters({ datePreset: 'all' })
    await flush()
    expect(got.since).toBeUndefined()
  })
})

describe('runHistory store — setSearchText (debounced)', () => {
  beforeEach(() => {
    searchRuns.mockReset()
    searchRuns.mockResolvedValue([])
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('updates the bound filter value immediately but does not fetch until the debounce elapses', () => {
    const s = createRunHistoryStore()
    s.setSearchText('back')
    expect(s.filters.searchText).toBe('back')
    expect(searchRuns).not.toHaveBeenCalled()
    vi.advanceTimersByTime(299)
    expect(searchRuns).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ searchText: 'back' }))
  })

  it('rapid keystrokes only fire ONE fetch, for the final value', () => {
    const s = createRunHistoryStore()
    s.setSearchText('b')
    vi.advanceTimersByTime(100)
    s.setSearchText('ba')
    vi.advanceTimersByTime(100)
    s.setSearchText('backup')
    vi.advanceTimersByTime(300)
    expect(searchRuns).toHaveBeenCalledTimes(1)
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ searchText: 'backup' }))
  })

  it('an empty search string is sent as undefined (not an empty-string LIKE filter)', () => {
    const s = createRunHistoryStore()
    s.setSearchText('')
    vi.advanceTimersByTime(300)
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ searchText: undefined }))
  })
})

describe('runHistory store — loadMore', () => {
  beforeEach(() => searchRuns.mockReset())

  it('re-queries with limit + RUN_SEARCH_PAGE_SIZE and replaces runs with the wider result', async () => {
    searchRuns.mockResolvedValueOnce(rows(RUN_SEARCH_PAGE_SIZE)) // first page: full, hasMore=true
    const s = createRunHistoryStore()
    await s.refresh()
    expect(s.hasMore).toBe(true)

    searchRuns.mockResolvedValueOnce(rows(RUN_SEARCH_PAGE_SIZE + 10))
    await s.loadMore()
    expect(searchRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: RUN_SEARCH_PAGE_SIZE * 2 }))
    expect(s.runs).toHaveLength(RUN_SEARCH_PAGE_SIZE + 10)
  })

  it('is a no-op when hasMore is false', async () => {
    searchRuns.mockResolvedValueOnce(rows(3)) // fewer than a page → hasMore=false
    const s = createRunHistoryStore()
    await s.refresh()
    searchRuns.mockClear()
    await s.loadMore()
    expect(searchRuns).not.toHaveBeenCalled()
  })

  it('is a no-op while a previous loadMore is already in flight', async () => {
    searchRuns.mockResolvedValueOnce(rows(RUN_SEARCH_PAGE_SIZE))
    const s = createRunHistoryStore()
    await s.refresh()
    searchRuns.mockClear() // isolate the count below to loadMore's own calls, not refresh()'s
    // Held open deliberately (not "never resolves") so the test itself resolves it before
    // finishing — an actually-dangling promise across a test boundary risks the same kind of
    // spurious unhandled-rejection/hang this file's mockRejectedValue fix works around.
    let resolveLoadMore!: (v: unknown[]) => void
    searchRuns.mockReturnValue(new Promise((res) => { resolveLoadMore = res }))
    const p1 = s.loadMore()
    const p2 = s.loadMore() // should be dropped, not queued
    expect(searchRuns).toHaveBeenCalledTimes(1)
    resolveLoadMore([])
    await Promise.all([p1, p2])
  })
})

describe('runHistory store — clearFilters', () => {
  it('resets every filter to its default and refreshes', async () => {
    searchRuns.mockResolvedValue([])
    const s = createRunHistoryStore()
    s.setFilters({ jobId: 5, result: 'failure', datePreset: '7d' })
    await flush()
    searchRuns.mockClear()
    s.clearFilters()
    expect(s.filters).toEqual({ jobId: null, result: null, datePreset: 'all', searchText: '' })
    expect(searchRuns).toHaveBeenCalledWith({ jobId: undefined, result: undefined, since: undefined, searchText: undefined, limit: RUN_SEARCH_PAGE_SIZE })
  })

  it('cancels a pending debounced search', () => {
    vi.useFakeTimers()
    try {
      searchRuns.mockResolvedValue([])
      const s = createRunHistoryStore()
      s.setSearchText('partial')
      s.clearFilters() // fires its own immediate refresh
      searchRuns.mockClear()
      vi.advanceTimersByTime(400) // the debounced 'partial' search must NOT also fire now
      expect(searchRuns).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'

const dashboardSummary = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
beforeEach(() => { (globalThis as any).window = { chronos: { dashboardSummary } } })

import { createDashboardStore } from '../../src/renderer/src/stores/dashboard.store'

/** Flush pending microtasks (and one macrotask hop) — used instead of `await Promise.resolve()`
 *  so the in-flight refresh's async continuation (including its `finally`, which clears the
 *  in-flight guard) has definitely run before the next assertion. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const summary = (over: Record<string, unknown> = {}) => ({
  runsToday: 3,
  succeededToday: 2,
  failedToday: 1,
  activeJobs: 5,
  failures: [],
  failuresTotal: 0,
  upcoming: [],
  generatedAt: 0,
  ...over
})

describe('dashboard store', () => {
  it('refresh() loads the summary and toggles loading', async () => {
    dashboardSummary.mockResolvedValue(summary())
    const s = createDashboardStore()
    expect(s.loading).toBe(false)
    expect(s.summary).toBe(null)
    const p = s.refresh()
    expect(s.loading).toBe(true)
    await p
    expect(s.loading).toBe(false)
    expect(s.summary).toEqual(summary())
    expect(s.error).toBe(null)
  })

  it('refresh() records an error and keeps the previous summary on failure', async () => {
    dashboardSummary.mockResolvedValueOnce(summary({ runsToday: 9 }))
    const s = createDashboardStore()
    await s.refresh()
    expect(s.summary).toEqual(summary({ runsToday: 9 }))

    dashboardSummary.mockRejectedValueOnce(new Error('dashboard read failed'))
    await s.refresh()
    expect(s.error).toBe('dashboard read failed')
    // Previous summary is retained, not wiped, on a failed refresh.
    expect(s.summary).toEqual(summary({ runsToday: 9 }))
    expect(s.loading).toBe(false)
  })

  it('applyRunEvent triggers a refresh on finished and jobsChanged', async () => {
    dashboardSummary.mockResolvedValue(summary())
    const s = createDashboardStore()
    await s.refresh()
    dashboardSummary.mockClear()

    s.applyRunEvent({ kind: 'finished', runId: 9, result: 'success', exitCode: 0, endedAt: 1 })
    expect(dashboardSummary).toHaveBeenCalledTimes(1)
    await flush() // let this refresh settle (clears the in-flight guard) before the next trigger

    s.applyRunEvent({ kind: 'jobsChanged' })
    expect(dashboardSummary).toHaveBeenCalledTimes(2)
    await flush()
  })

  it('applyRunEvent dedupes two triggers that land while a refresh is still in flight (MUST FIX #1)', async () => {
    dashboardSummary.mockResolvedValue(summary())
    const s = createDashboardStore()
    await s.refresh()
    dashboardSummary.mockClear()

    let resolveNext!: (v: ReturnType<typeof summary>) => void
    dashboardSummary.mockReturnValue(new Promise((res) => { resolveNext = res }))

    // finished and jobsChanged land in the same tick (e.g. a run finishes and the job list
    // reconciles at once) — the second must join the first's in-flight refresh, not fire again.
    s.applyRunEvent({ kind: 'finished', runId: 9, result: 'success', exitCode: 0, endedAt: 1 })
    s.applyRunEvent({ kind: 'jobsChanged' })
    expect(dashboardSummary).toHaveBeenCalledTimes(1)

    resolveNext(summary({ runsToday: 7 }))
    await flush()
    expect(s.summary).toEqual(summary({ runsToday: 7 }))
  })

  it('applyRunEvent does NOT refresh on started or output', async () => {
    dashboardSummary.mockResolvedValue(summary())
    const s = createDashboardStore()
    await s.refresh()
    dashboardSummary.mockClear()

    s.applyRunEvent({ kind: 'started', jobId: 1, runId: 9, triggeredBy: 'manual', startedAt: 0 })
    s.applyRunEvent({ kind: 'output', runId: 9, stream: 'stdout', chunk: 'hi\n' })
    expect(dashboardSummary).not.toHaveBeenCalled()
  })

  it('a background refresh (summary already loaded) never flips loading to true (MUST FIX #1)', async () => {
    dashboardSummary.mockResolvedValue(summary())
    const s = createDashboardStore()
    await s.refresh() // first load — establishes state.summary !== null
    expect(s.loading).toBe(false)

    let resolveSecond!: (v: ReturnType<typeof summary>) => void
    dashboardSummary.mockReturnValue(new Promise((res) => { resolveSecond = res }))
    const p = s.refresh() // background refresh — must NOT flash the skeleton
    expect(s.loading).toBe(false)
    resolveSecond(summary({ runsToday: 99 }))
    await p
    expect(s.loading).toBe(false)
    expect(s.summary).toEqual(summary({ runsToday: 99 }))
  })

  it('overlapping refresh() calls join the in-flight request instead of firing a second IPC call', async () => {
    dashboardSummary.mockClear() // call count must start at 0 — earlier tests share this module-level mock
    let resolveFirst!: (v: ReturnType<typeof summary>) => void
    dashboardSummary.mockReturnValue(new Promise((res) => { resolveFirst = res }))
    const s = createDashboardStore()

    const p1 = s.refresh()
    const p2 = s.refresh() // overlaps p1 — must not trigger a 2nd IPC call
    expect(dashboardSummary).toHaveBeenCalledTimes(1)

    resolveFirst(summary({ runsToday: 42 }))
    await Promise.all([p1, p2])
    expect(dashboardSummary).toHaveBeenCalledTimes(1)
    expect(s.summary).toEqual(summary({ runsToday: 42 }))

    // Once the in-flight call has settled, a subsequent refresh() fires a fresh IPC call again.
    dashboardSummary.mockResolvedValue(summary({ runsToday: 43 }))
    await s.refresh()
    expect(dashboardSummary).toHaveBeenCalledTimes(2)
  })
})

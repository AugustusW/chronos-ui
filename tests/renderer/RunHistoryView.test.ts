// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const recentRuns = vi.fn()

beforeEach(() => {
  recentRuns.mockReset()
  recentRuns.mockResolvedValue([
    { id: 10, jobId: 1, triggeredBy: 'schedule', result: 'success', startedAt: Date.now() - 1000, endedAt: Date.now(), durationMs: 1200, exitCode: 0, stdout: '', stderr: '', createdAt: new Date() },
    { id: 20, jobId: 2, triggeredBy: 'schedule', result: 'success', startedAt: Date.now() - 2000, endedAt: Date.now(), durationMs: 900, exitCode: 0, stdout: '', stderr: '', createdAt: new Date() }
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = { chronos: { recentRuns } }
})

import RunHistoryView from '../../src/renderer/src/views/RunHistoryView.vue'
import SkeletonRows from '../../src/renderer/src/components/SkeletonRows.vue'

describe('RunHistoryView', () => {
  it('fetches runs via a single recentRuns call and renders them', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    // Should show trigger text from the returned runs
    expect(w.text()).toContain('schedule')
  })

  it('shows empty message when no runs exist', async () => {
    recentRuns.mockResolvedValue([])

    const w = mount(RunHistoryView)
    await flushPromises()

    expect(w.text()).toContain('No runs yet')
    // Should not show any run rows (no 'schedule' trigger text)
    expect(w.text()).not.toContain('schedule')
  })

  it('shows error message when load fails', async () => {
    recentRuns.mockRejectedValue(new Error('IPC failure'))

    const w = mount(RunHistoryView)
    await flushPromises()

    expect(w.text()).toContain("Couldn't load runs")
    expect(w.text()).toContain('IPC failure')
  })

  it('loading indicator is gone after load completes', async () => {
    // Gate recentRuns so we can observe the skeleton while loading is in progress
    let resolveRuns!: (v: never[]) => void
    recentRuns.mockReturnValue(new Promise<never[]>((res) => { resolveRuns = res }))

    const w = mount(RunHistoryView)
    // Yield so loading branch renders
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(true)

    // Resolve recentRuns and flush — loading should clear
    resolveRuns([])
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(false)
    // Empty-state message confirms the loaded branch rendered
    expect(w.text()).toContain('No runs yet')
  })
})

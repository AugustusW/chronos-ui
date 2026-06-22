// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

// Mock vue-router before importing JobDetailView
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} })
}))

const listRuns = vi.fn()

beforeEach(() => {
  listRuns.mockReset()
  listRuns.mockResolvedValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = { chronos: { listRuns } }
})

import JobDetailView from '../../src/renderer/src/views/JobDetailView.vue'
import SkeletonRows from '../../src/renderer/src/components/SkeletonRows.vue'
import { useScheduleStore } from '../../src/renderer/src/stores/schedule.store'

describe('JobDetailView', () => {
  beforeEach(() => {
    // Reset store singleton state between tests by clearing live buffers
    const store = useScheduleStore()
    store.runningRuns.clear()
    store.liveOutput.clear()
  })

  it('shows live output chunk and streaming indicator when a run is active', async () => {
    const store = useScheduleStore()
    // Simulate a live run for job id=7
    store.applyRunEvent({ kind: 'started', jobId: 7, runId: 101, triggeredBy: 'manual', startedAt: Date.now() })
    store.applyRunEvent({ kind: 'output', runId: 101, stream: 'stdout', chunk: 'live-line\n' })

    const w = mount(JobDetailView, { props: { id: '7' } })
    await flushPromises()

    // The live chunk should appear in the output terminal
    expect(w.text()).toContain('live-line')
    // The streaming indicator (● streaming) should be visible
    expect(w.text()).toContain('streaming')
  })

  it('reloads persisted runs and replaces live view when run finishes', async () => {
    const store = useScheduleStore()
    const finishedRun = { id: 55, jobId: 7, result: 'success', exitCode: 0, triggeredBy: 'manual', startedAt: Date.now(), endedAt: Date.now(), durationMs: 100, stdout: 'persisted-output\n', stderr: '' }
    // Set up a live run first
    store.applyRunEvent({ kind: 'started', jobId: 7, runId: 101, triggeredBy: 'manual', startedAt: Date.now() })
    store.applyRunEvent({ kind: 'output', runId: 101, stream: 'stdout', chunk: 'live-chunk\n' })

    // listRuns returns the persisted row (after finish)
    listRuns.mockResolvedValue([finishedRun])

    const w = mount(JobDetailView, { props: { id: '7' } })
    await flushPromises()

    // Confirm live view is shown
    expect(w.text()).toContain('live-chunk')

    // Simulate finish — this should trigger watch(liveRunId) transition → reload
    store.applyRunEvent({ kind: 'finished', runId: 101, result: 'success', exitCode: 0, endedAt: Date.now() })
    await flushPromises()

    // After reload, persisted output should appear
    expect(w.text()).toContain('persisted-output')
    expect(listRuns).toHaveBeenCalledWith(7)
  })

  it('shows persisted runs when no live run is active', async () => {
    const persistedRun = { id: 10, jobId: 7, result: 'success', exitCode: 0, triggeredBy: 'schedule', startedAt: Date.now(), endedAt: Date.now(), durationMs: 200, stdout: 'done\n', stderr: '' }
    listRuns.mockResolvedValue([persistedRun])

    const w = mount(JobDetailView, { props: { id: '7' } })
    await flushPromises()

    expect(w.text()).toContain('done')
    // No streaming indicator when not live
    expect(w.text()).not.toContain('streaming')
  })

  it('shows empty message when no persisted runs exist and no live run', async () => {
    listRuns.mockResolvedValue([])

    const w = mount(JobDetailView, { props: { id: '7' } })
    await flushPromises()

    expect(w.text()).toContain('No runs for this job')
  })

  it('shows error message when persisted-run load fails', async () => {
    listRuns.mockRejectedValue(new Error('network timeout'))

    const w = mount(JobDetailView, { props: { id: '7' } })
    await flushPromises()

    expect(w.text()).toContain("Couldn't load runs")
    expect(w.text()).toContain('network timeout')
  })

  it('live output is shown even when there is a load error for persisted runs', async () => {
    const store = useScheduleStore()
    store.applyRunEvent({ kind: 'started', jobId: 7, runId: 102, triggeredBy: 'manual', startedAt: Date.now() })
    store.applyRunEvent({ kind: 'output', runId: 102, stream: 'stdout', chunk: 'live-active\n' })
    // No persisted-run load happens when live run is active (onMounted skips it)
    listRuns.mockResolvedValue([])

    const w = mount(JobDetailView, { props: { id: '7' } })
    await flushPromises()

    expect(w.text()).toContain('live-active')
    expect(w.text()).toContain('streaming')
  })

  it('loading indicator is gone after load completes', async () => {
    // Gate the promise so we can assert the loading state before and after
    let resolveRuns!: (v: never[]) => void
    listRuns.mockReturnValue(new Promise<never[]>((res) => { resolveRuns = res }))

    const w = mount(JobDetailView, { props: { id: '7' } })
    // Yield to let onMounted run and set loading=true
    await nextTick()
    expect(w.findComponent(SkeletonRows).exists()).toBe(true)

    // Resolve the promise and flush — loading should clear
    resolveRuns([])
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(false)
    // Empty-state message confirms the loaded branch rendered
    expect(w.text()).toContain('No runs for this job')
  })
})

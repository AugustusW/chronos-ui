// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton, useScheduleStore } from '../../src/renderer/src/stores/schedule.store'

const listJobs = vi.fn()
const createJob = vi.fn().mockResolvedValue({ ok: true })
const updateJob = vi.fn().mockResolvedValue({ ok: true })
const adoptJobs = vi.fn().mockResolvedValue([])
const enableJob = vi.fn().mockResolvedValue({ ok: true })
const disableJob = vi.fn().mockResolvedValue({ ok: true })
const deleteJob = vi.fn().mockResolvedValue({ ok: true })
const runNowStreaming = vi.fn().mockResolvedValue(undefined)
const pushSpy = vi.fn()

// Mock vue-router BEFORE importing SchedulesView so the mock is in place
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushSpy }),
  useRoute: () => ({ params: {} })
}))

beforeEach(() => {
  listJobs.mockReset()
  createJob.mockReset()
  createJob.mockResolvedValue({ ok: true })
  updateJob.mockReset()
  updateJob.mockResolvedValue({ ok: true })
  adoptJobs.mockReset()
  adoptJobs.mockResolvedValue([])
  enableJob.mockReset()
  enableJob.mockResolvedValue({ ok: true })
  disableJob.mockReset()
  disableJob.mockResolvedValue({ ok: true })
  deleteJob.mockReset()
  deleteJob.mockResolvedValue({ ok: true })
  runNowStreaming.mockReset()
  runNowStreaming.mockResolvedValue(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = { chronos: { listJobs, createJob, updateJob, adoptJobs, enableJob, disableJob, deleteJob, runNowStreaming } }
  pushSpy.mockClear()
  // Reset the store singleton so each test gets a fresh store
  _resetSingleton()
})

import SchedulesView from '../../src/renderer/src/views/SchedulesView.vue'

// Two managed jobs for batch tests
const TWO_JOBS_RESPONSE = {
  items: [
    { status: 'in_sync', job: { id: 1, name: 'Alpha', category: 'backups', scheduleExpr: '0 3 * * *', command: '/a.sh', enabled: true, adopted: true, lastResult: 'success' }, native: {} },
    { status: 'in_sync', job: { id: 2, name: 'Beta', category: 'backups', scheduleExpr: '0 4 * * *', command: '/b.sh', enabled: true, adopted: true, lastResult: 'success' }, native: {} }
  ],
  generatedAt: 0
}

// One managed + one unmanaged
const MIXED_RESPONSE = {
  items: [
    { status: 'in_sync', job: { id: 5, name: 'Managed', category: 'cron', scheduleExpr: '0 2 * * *', command: '/m.sh', enabled: true, adopted: true, lastResult: 'success', workingDir: null, timeoutSec: null }, native: {} },
    { status: 'unmanaged', native: { chronosId: null, scheduleExpr: '0 6 * * *', scheduleExprFormat: 'cron', command: '/u.sh', adopted: false, enabled: true } }
  ],
  generatedAt: 0
}

describe('SchedulesView', () => {
  it('shows the empty state when there are no jobs', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    const w = mount(SchedulesView)
    await flushPromises()
    expect(w.text()).toContain('Bring order to your schedules')
  })
  it('groups jobs by category', async () => {
    listJobs.mockResolvedValue({ items: [
      { status: 'in_sync', job: { id: 1, name: 'A', category: 'backups', scheduleExpr: '0 3 * * *', command: '/a', enabled: true, adopted: true, lastResult: 'success' }, native: {} }
    ], generatedAt: 0 })
    const w = mount(SchedulesView)
    await flushPromises()
    expect(w.text()).toContain('backups')
    expect(w.text()).toContain('A')
  })
  it('navigates to /jobs/:id when a JobRow emits open-detail', async () => {
    listJobs.mockResolvedValue({ items: [
      { status: 'in_sync', job: { id: 42, name: 'Nightly', category: 'backups', scheduleExpr: '0 3 * * *', command: '/n.sh', enabled: true, adopted: true, lastResult: 'success' }, native: {} }
    ], generatedAt: 0 })
    const w = mount(SchedulesView)
    await flushPromises()
    // Use $emit directly to simulate the custom event from JobRow (trigger() only works for DOM events)
    w.findComponent({ name: 'JobRow' }).vm.$emit('open-detail')
    await flushPromises()
    expect(pushSpy).toHaveBeenCalledWith('/jobs/42')
  })

  // FT4b: job creation + scan CTAs
  it('opens JobEditor when EmptyState emits new', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    const w = mount(SchedulesView)
    await flushPromises()
    // Before emitting, JobEditor should exist but be closed
    const jobEditorBefore = w.findComponent({ name: 'JobEditor' })
    expect(jobEditorBefore.exists()).toBe(true)
    expect(jobEditorBefore.props('open')).toBe(false)
    // Simulate EmptyState emitting 'new'
    w.findComponent({ name: 'EmptyState' }).vm.$emit('new')
    await flushPromises()
    // JobEditor should now be open
    expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
  })

  it('calls createJob + refreshes when JobEditor emits save (create mode), then closes editor', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    const w = mount(SchedulesView)
    await flushPromises()
    // Open the editor via EmptyState
    w.findComponent({ name: 'EmptyState' }).vm.$emit('new')
    await flushPromises()
    const listCallsBefore = listJobs.mock.calls.length
    // Simulate JobEditor emitting 'save' with a CreateJobInput
    const input = { name: 'Nightly', scheduleExpr: '0 3 * * *', command: '/backup.sh' }
    w.findComponent({ name: 'JobEditor' }).vm.$emit('save', input)
    await flushPromises()
    expect(createJob).toHaveBeenCalledWith(input)
    expect(updateJob).not.toHaveBeenCalled()
    expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
    // Editor should close after save
    expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(false)
  })

  it('refreshes (re-calls listJobs) when EmptyState emits scan', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    const w = mount(SchedulesView)
    await flushPromises()
    const listCallsBefore = listJobs.mock.calls.length
    // Simulate EmptyState emitting 'scan'
    w.findComponent({ name: 'EmptyState' }).vm.$emit('scan')
    await flushPromises()
    expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
  })

  it('keeps editor open and does NOT refresh when createJob rejects', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    createJob.mockRejectedValueOnce(new Error('boom'))
    const w = mount(SchedulesView)
    await flushPromises()
    // Open editor
    w.findComponent({ name: 'EmptyState' }).vm.$emit('new')
    await flushPromises()
    expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
    const listCallsBefore = listJobs.mock.calls.length
    // Attempt save that will fail
    const input = { name: 'Fail', scheduleExpr: '0 3 * * *', command: '/fail.sh' }
    w.findComponent({ name: 'JobEditor' }).vm.$emit('save', input)
    await flushPromises()
    // Editor must remain open
    expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
    // No additional listJobs call after failed create
    expect(listJobs.mock.calls.length).toBe(listCallsBefore)
  })

  it('keeps the editor open and surfaces the error when createJob returns { ok: false }', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    createJob.mockResolvedValueOnce({ ok: false, error: 'native write failed' })
    const w = mount(SchedulesView)
    await flushPromises()
    w.findComponent({ name: 'EmptyState' }).vm.$emit('new')
    await flushPromises()
    const listCallsBefore = listJobs.mock.calls.length
    const input = { name: 'New', scheduleExpr: '0 3 * * *', command: '/n.sh' }
    w.findComponent({ name: 'JobEditor' }).vm.$emit('save', input)
    await flushPromises()
    // Structured {ok:false} (not a thrown error) must also be surfaced, not silently swallowed.
    expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
    expect(w.text()).toContain('native write failed')
    expect(listJobs.mock.calls.length).toBe(listCallsBefore)
  })

  // Plan 6 FU1: per-row edit (managed) + adopt (unmanaged)
  describe('per-row edit + adopt', () => {
    it('JobRow @edit opens the editor with initial set to the job fields', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()
      // Find the managed JobRow and emit 'edit'
      const rows = w.findAllComponents({ name: 'JobRow' })
      const managedRow = rows.find((r) => r.props('item').status === 'in_sync')!
      expect(managedRow).toBeTruthy()
      managedRow.vm.$emit('edit')
      await flushPromises()
      // Editor should open
      const editor = w.findComponent({ name: 'JobEditor' })
      expect(editor.props('open')).toBe(true)
      // initial should be prefilled with the job's values
      const initial = editor.props('initial') as Record<string, unknown>
      expect(initial).toBeTruthy()
      expect(initial.name).toBe('Managed')
      expect(initial.scheduleExpr).toBe('0 2 * * *')
      expect(initial.command).toBe('/m.sh')
    })

    it('saving in edit mode calls updateJob(id, input) NOT createJob, then refreshes + closes', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()
      // Trigger edit for the managed row
      const managedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'in_sync')!
      managedRow.vm.$emit('edit')
      await flushPromises()
      const listCallsBefore = listJobs.mock.calls.length
      const input = { name: 'Managed', scheduleExpr: '0 2 * * *', command: '/m.sh' }
      w.findComponent({ name: 'JobEditor' }).vm.$emit('save', input)
      await flushPromises()
      expect(updateJob).toHaveBeenCalledWith(5, input)
      expect(createJob).not.toHaveBeenCalled()
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(false)
    })

    it('keeps the editor open and surfaces the error when updateJob returns { ok: false }', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      updateJob.mockResolvedValueOnce({ ok: false, error: 'cannot change command of an adopted job; unadopt then adopt' })
      const w = mount(SchedulesView)
      await flushPromises()
      const managedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'in_sync')!
      managedRow.vm.$emit('edit')
      await flushPromises()
      const listCallsBefore = listJobs.mock.calls.length
      const input = { name: 'Renamed', scheduleExpr: '0 2 * * *', command: '/m.sh' }
      w.findComponent({ name: 'JobEditor' }).vm.$emit('save', input)
      await flushPromises()
      // The mock stands in for any server-side rejection (adopted-command guard, drift, etc.):
      // a rejected write must not be swallowed — editor stays open, error shown, no refresh.
      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
      expect(w.text()).toContain('cannot change command of an adopted job')
      expect(listJobs.mock.calls.length).toBe(listCallsBefore)
    })

    it('JobRow @adopt for an unmanaged row calls adoptJobs + refreshes', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()
      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      expect(unmanagedRow).toBeTruthy()
      const listCallsBefore = listJobs.mock.calls.length
      unmanagedRow.vm.$emit('adopt')
      await flushPromises()
      expect(adoptJobs).toHaveBeenCalledWith([{ scheduleExpr: '0 6 * * *', command: '/u.sh' }])
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
    })
  })

  // Plan 6: batch actions
  describe('batch actions', () => {
    it('batch run: calls runNowStreaming once per selected managed job', async () => {
      listJobs.mockResolvedValue(TWO_JOBS_RESPONSE)
      mount(SchedulesView)
      await flushPromises()
      // Drive the store directly to set up selection
      const store = useScheduleStore()
      store.selectMode = true
      store.toggleSelect(1)
      store.toggleSelect(2)
      await flushPromises()
      // Trigger batchRun via BatchActionBar @run emit
      // Re-mount with selection already in store
      const w2 = mount(SchedulesView)
      await flushPromises()
      w2.findComponent({ name: 'BatchActionBar' }).vm.$emit('run')
      await flushPromises()
      expect(runNowStreaming).toHaveBeenCalledTimes(2)
      expect(runNowStreaming).toHaveBeenCalledWith(1)
      expect(runNowStreaming).toHaveBeenCalledWith(2)
    })

    it('batch enable: calls enableJob per selected id then refreshes', async () => {
      listJobs.mockResolvedValue(TWO_JOBS_RESPONSE)
      mount(SchedulesView)
      await flushPromises()
      const store = useScheduleStore()
      store.selectMode = true
      store.toggleSelect(1)
      store.toggleSelect(2)
      await flushPromises()
      const w2 = mount(SchedulesView)
      await flushPromises()
      const listCallsBefore = listJobs.mock.calls.length
      w2.findComponent({ name: 'BatchActionBar' }).vm.$emit('enable')
      await flushPromises()
      expect(enableJob).toHaveBeenCalledWith(1)
      expect(enableJob).toHaveBeenCalledWith(2)
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
    })

    it('batch delete: calls deleteJob per selected id then refreshes', async () => {
      listJobs.mockResolvedValue(TWO_JOBS_RESPONSE)
      mount(SchedulesView)
      await flushPromises()
      const store = useScheduleStore()
      store.selectMode = true
      store.toggleSelect(1)
      store.toggleSelect(2)
      await flushPromises()
      const w2 = mount(SchedulesView)
      await flushPromises()
      const listCallsBefore = listJobs.mock.calls.length
      // Drive @delete directly — BatchActionBar already gated with confirm before emitting
      w2.findComponent({ name: 'BatchActionBar' }).vm.$emit('delete')
      await flushPromises()
      expect(deleteJob).toHaveBeenCalledWith(1)
      expect(deleteJob).toHaveBeenCalledWith(2)
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
    })

    it('batch cancel: clears batchState (running prop becomes undefined/null)', async () => {
      // Use a controllable gate so we can assert the batch is genuinely in-progress before cancelling
      let resolveFirst: (() => void) | undefined
      const gate = new Promise<void>((r) => { resolveFirst = r })
      runNowStreaming.mockReturnValueOnce(gate)
      runNowStreaming.mockResolvedValue(undefined)

      listJobs.mockResolvedValue(TWO_JOBS_RESPONSE)
      mount(SchedulesView)
      await flushPromises()
      const store = useScheduleStore()
      store.selectMode = true
      store.toggleSelect(1)
      store.toggleSelect(2)
      await flushPromises()
      const w2 = mount(SchedulesView)
      await flushPromises()

      const bar = w2.findComponent({ name: 'BatchActionBar' })

      // Start batch run (will be blocked on the gate for job 1)
      bar.vm.$emit('run')
      // Flush microtasks so batchState is set and the loop is parked on await gate
      await Promise.resolve()
      await Promise.resolve()
      await w2.vm.$nextTick()

      // Assert batch is genuinely IN PROGRESS before we cancel
      expect(bar.props('running')).toBeTruthy()

      // Cancel while in progress
      bar.vm.$emit('cancel')
      await flushPromises()

      // After cancel, batchState is null → :running passed as undefined → falsy
      expect(bar.props('running')).toBeFalsy()

      // Resolve the gate so the loop can finish cleanly (batchCancel flag stops job 2)
      resolveFirst!()
      await flushPromises()

      // Job 2 must NOT have been called — cancel interrupted the batch
      expect(runNowStreaming).toHaveBeenCalledTimes(1)
      expect(runNowStreaming).toHaveBeenCalledWith(1)
    })
  })
})

// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton, useScheduleStore } from '../../src/renderer/src/stores/schedule.store'

const managedCount = vi.fn().mockResolvedValue(1) // default: 1 so existing tests still trigger listJobs
const listJobs = vi.fn()
const forgetJob = vi.fn().mockResolvedValue({ ok: true })
const deleteJob = vi.fn().mockResolvedValue({ ok: true })
const createJob = vi.fn().mockResolvedValue({ ok: true })
const updateJob = vi.fn().mockResolvedValue({ ok: true })
const adoptJobs = vi.fn().mockResolvedValue({ ok: true, adopted: [] })
const unadoptJob = vi.fn().mockResolvedValue({ ok: true })
const enableJob = vi.fn().mockResolvedValue({ ok: true })
const disableJob = vi.fn().mockResolvedValue({ ok: true })
const runNowStreaming = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} }),
}))

beforeEach(() => {
  managedCount.mockReset()
  managedCount.mockResolvedValue(1) // default: 1 so existing tests still trigger listJobs
  listJobs.mockReset()
  forgetJob.mockReset()
  forgetJob.mockResolvedValue({ ok: true })
  deleteJob.mockReset()
  deleteJob.mockResolvedValue({ ok: true })
  createJob.mockReset()
  createJob.mockResolvedValue({ ok: true })
  updateJob.mockReset()
  updateJob.mockResolvedValue({ ok: true })
  adoptJobs.mockReset()
  adoptJobs.mockResolvedValue({ ok: true, adopted: [] })
  unadoptJob.mockReset()
  unadoptJob.mockResolvedValue({ ok: true })
  enableJob.mockReset()
  enableJob.mockResolvedValue({ ok: true })
  disableJob.mockReset()
  disableJob.mockResolvedValue({ ok: true })
  runNowStreaming.mockReset()
  runNowStreaming.mockResolvedValue(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = {
    chronos: {
      managedCount, listJobs, forgetJob, deleteJob, createJob, updateJob,
      adoptJobs, unadoptJob, enableJob, disableJob, runNowStreaming,
    },
    confirm: vi.fn().mockReturnValue(true),
  }
  _resetSingleton()
})

import SchedulesView from '../../src/renderer/src/views/SchedulesView.vue'

// A not-adopted managed job (id=11, name='Nightly')
const NOT_ADOPTED_RESPONSE = {
  items: [
    {
      status: 'in_sync',
      job: {
        id: 11,
        name: 'Nightly',
        category: 'backups',
        scheduleExpr: '0 3 * * *',
        command: '/nightly.sh',
        enabled: true,
        adopted: false,
        lastResult: 'success',
        workingDir: null,
        timeoutSec: null,
      },
      native: {},
    },
  ],
  generatedAt: 0,
}

// Two jobs for batch delete tests
const TWO_JOBS_RESPONSE = {
  items: [
    {
      status: 'in_sync',
      job: { id: 1, name: 'Alpha', category: 'backups', scheduleExpr: '0 3 * * *', command: '/a.sh', enabled: true, adopted: true, lastResult: 'success', workingDir: null, timeoutSec: null },
      native: {},
    },
    {
      status: 'in_sync',
      job: { id: 2, name: 'Beta', category: 'backups', scheduleExpr: '0 4 * * *', command: '/b.sh', enabled: true, adopted: true, lastResult: 'success', workingDir: null, timeoutSec: null },
      native: {},
    },
  ],
  generatedAt: 0,
}

describe('SchedulesView — Forget + Delete confirmation', () => {
  describe('Forget flow', () => {
    it('JobEditor emitting forget calls forgetJob(id) and shows success + closes editor + refreshes', async () => {
      listJobs.mockResolvedValue(NOT_ADOPTED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      // Open editor on the not-adopted job
      const row = w.findAllComponents({ name: 'JobRow' })[0]!
      row.vm.$emit('edit')
      await flushPromises()

      const editor = w.findComponent({ name: 'JobEditor' })
      expect(editor.props('open')).toBe(true)

      const listCallsBefore = listJobs.mock.calls.length
      editor.vm.$emit('forget')
      await flushPromises()

      expect(forgetJob).toHaveBeenCalledWith(11)
      // Editor closes on success
      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(false)
      // Refresh triggered
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
      // Success feedback shown
      expect(w.text()).toContain('Forgot')
    })

    it('shows error feedback and keeps editor open when forgetJob returns {ok:false}', async () => {
      forgetJob.mockResolvedValueOnce({ ok: false, error: 'adopted job — use unadopt to revert the wrap' })
      listJobs.mockResolvedValue(NOT_ADOPTED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const row = w.findAllComponents({ name: 'JobRow' })[0]!
      row.vm.$emit('edit')
      await flushPromises()

      const listCallsBefore = listJobs.mock.calls.length
      w.findComponent({ name: 'JobEditor' }).vm.$emit('forget')
      await flushPromises()

      expect(forgetJob).toHaveBeenCalledWith(11)
      // Editor stays open on failure
      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
      // Error shown
      expect(w.text()).toContain('Forget failed')
      // No refresh
      expect(listJobs.mock.calls.length).toBe(listCallsBefore)
    })

    it('shows error feedback and keeps editor open when forgetJob throws', async () => {
      forgetJob.mockRejectedValueOnce(new Error('IPC error'))
      listJobs.mockResolvedValue(NOT_ADOPTED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const row = w.findAllComponents({ name: 'JobRow' })[0]!
      row.vm.$emit('edit')
      await flushPromises()

      w.findComponent({ name: 'JobEditor' }).vm.$emit('forget')
      await flushPromises()

      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
      expect(w.text()).toContain('Forget failed')
    })
  })

  describe('Delete confirmation', () => {
    it('batch delete: when window.confirm returns false, deleteJob is NOT called', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).window.confirm = vi.fn().mockReturnValue(false)
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
      w2.findComponent({ name: 'BatchActionBar' }).vm.$emit('delete')
      await flushPromises()

      expect(deleteJob).not.toHaveBeenCalled()
    })

    it('batch delete: when window.confirm returns true, deleteJob is called for each selected id', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(globalThis as any).window.confirm = vi.fn().mockReturnValue(true)
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
      w2.findComponent({ name: 'BatchActionBar' }).vm.$emit('delete')
      await flushPromises()

      expect(deleteJob).toHaveBeenCalledWith(1)
      expect(deleteJob).toHaveBeenCalledWith(2)
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
    })
  })
})

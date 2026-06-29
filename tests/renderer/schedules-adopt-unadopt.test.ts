// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton } from '../../src/renderer/src/stores/schedule.store'

const managedCount = vi.fn().mockResolvedValue(1) // default: 1 so existing tests still trigger listJobs
const listJobs = vi.fn()
const adoptJobs = vi.fn().mockResolvedValue({ ok: true, adopted: [1] })
const unadoptJob = vi.fn().mockResolvedValue({ ok: true })
const createJob = vi.fn().mockResolvedValue({ ok: true })
const updateJob = vi.fn().mockResolvedValue({ ok: true })
const enableJob = vi.fn().mockResolvedValue({ ok: true })
const disableJob = vi.fn().mockResolvedValue({ ok: true })
const deleteJob = vi.fn().mockResolvedValue({ ok: true })
const runNowStreaming = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} }),
}))

beforeEach(() => {
  managedCount.mockReset()
  managedCount.mockResolvedValue(1) // default: 1 so existing tests still trigger listJobs
  listJobs.mockReset()
  adoptJobs.mockReset()
  adoptJobs.mockResolvedValue({ ok: true, adopted: [1] })
  unadoptJob.mockReset()
  unadoptJob.mockResolvedValue({ ok: true })
  createJob.mockReset()
  createJob.mockResolvedValue({ ok: true })
  updateJob.mockReset()
  updateJob.mockResolvedValue({ ok: true })
  enableJob.mockReset()
  enableJob.mockResolvedValue({ ok: true })
  disableJob.mockReset()
  disableJob.mockResolvedValue({ ok: true })
  deleteJob.mockReset()
  deleteJob.mockResolvedValue({ ok: true })
  runNowStreaming.mockReset()
  runNowStreaming.mockResolvedValue(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = {
    chronos: {
      managedCount, listJobs, adoptJobs, unadoptJob,
      createJob, updateJob, enableJob, disableJob, deleteJob, runNowStreaming,
    },
  }
  _resetSingleton()
})

import SchedulesView from '../../src/renderer/src/views/SchedulesView.vue'

// One unmanaged + one adopted managed item
const MIXED_RESPONSE = {
  items: [
    {
      status: 'unmanaged',
      native: {
        chronosId: null,
        scheduleExpr: '0 6 * * *',
        scheduleExprFormat: 'cron',
        command: '/usr/bin/pg_dump assistant',
        adopted: false,
        enabled: true,
      },
    },
    {
      status: 'in_sync',
      job: {
        id: 7,
        name: 'pg_dump',
        category: 'backups',
        scheduleExpr: '0 6 * * *',
        command: '/usr/bin/pg_dump assistant',
        enabled: true,
        adopted: true,
        lastResult: 'success',
        workingDir: null,
        timeoutSec: null,
      },
      native: {},
    },
  ],
  generatedAt: 0,
}

describe('SchedulesView — AdoptDialog + Un-adopt + feedback', () => {
  describe('Adopt flow via AdoptDialog', () => {
    it('clicking JobRow @adopt does NOT call adoptJobs immediately', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      expect(unmanagedRow).toBeTruthy()

      unmanagedRow.vm.$emit('adopt')
      await flushPromises()

      expect(adoptJobs).not.toHaveBeenCalled()
    })

    it('clicking JobRow @adopt opens AdoptDialog with correct props', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      unmanagedRow.vm.$emit('adopt')
      await flushPromises()

      const dialog = w.findComponent({ name: 'AdoptDialog' })
      expect(dialog.props('open')).toBe(true)
      expect(dialog.props('schedule')).toBe('0 6 * * *')
      expect(dialog.props('command')).toBe('/usr/bin/pg_dump assistant')
    })

    it('confirming AdoptDialog calls adoptJobs with name + category + refreshes + shows success feedback', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      unmanagedRow.vm.$emit('adopt')
      await flushPromises()

      const listCallsBefore = listJobs.mock.calls.length
      const dialog = w.findComponent({ name: 'AdoptDialog' })
      dialog.vm.$emit('adopt', { name: 'pg_dump', category: 'backups' })
      await flushPromises()

      expect(adoptJobs).toHaveBeenCalledWith([{
        name: 'pg_dump',
        scheduleExpr: '0 6 * * *',
        command: '/usr/bin/pg_dump assistant',
        category: 'backups',
      }])
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
      // Dialog closes after success
      expect(w.findComponent({ name: 'AdoptDialog' }).props('open')).toBe(false)
      // Success feedback is shown
      expect(w.text()).toContain('Adopted')
      expect(w.text()).toContain('pg_dump')
    })

    it('cancelling AdoptDialog does not call adoptJobs and closes dialog', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      unmanagedRow.vm.$emit('adopt')
      await flushPromises()
      expect(w.findComponent({ name: 'AdoptDialog' }).props('open')).toBe(true)

      w.findComponent({ name: 'AdoptDialog' }).vm.$emit('cancel')
      await flushPromises()

      expect(adoptJobs).not.toHaveBeenCalled()
      expect(w.findComponent({ name: 'AdoptDialog' }).props('open')).toBe(false)
    })

    it('shows error feedback when adoptJobs throws', async () => {
      adoptJobs.mockRejectedValueOnce(new Error('adopt failed: quota exceeded'))
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      unmanagedRow.vm.$emit('adopt')
      await flushPromises()

      w.findComponent({ name: 'AdoptDialog' }).vm.$emit('adopt', { name: 'pg_dump' })
      await flushPromises()

      expect(w.text()).toContain('Adopt failed')
    })

    it('shows error and keeps AdoptDialog open when adoptJobs resolves {ok:false}', async () => {
      adoptJobs.mockResolvedValueOnce({ ok: false, reason: 'drift', error: 'crontab drifted', adopted: [] })
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const unmanagedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!
      unmanagedRow.vm.$emit('adopt')
      await flushPromises()

      const listCallsBefore = listJobs.mock.calls.length
      w.findComponent({ name: 'AdoptDialog' }).vm.$emit('adopt', { name: 'pg_dump' })
      await flushPromises()

      // Error surfaced
      expect(w.text()).toContain('Adopt failed')
      expect(w.text()).toContain('crontab drifted')
      // AdoptDialog stays open
      expect(w.findComponent({ name: 'AdoptDialog' }).props('open')).toBe(true)
      // No refresh
      expect(listJobs.mock.calls.length).toBe(listCallsBefore)
    })
  })

  describe('edit adopted job → passes adopted=true to JobEditor + unadopt', () => {
    it('opening edit on an adopted job passes adopted=true to JobEditor', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const adoptedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'in_sync')!
      adoptedRow.vm.$emit('edit')
      await flushPromises()

      const editor = w.findComponent({ name: 'JobEditor' })
      expect(editor.props('open')).toBe(true)
      expect(editor.props('adopted')).toBe(true)
    })

    it('opening edit on a non-adopted job passes adopted=false to JobEditor', async () => {
      // A managed-but-not-adopted job
      listJobs.mockResolvedValue({
        items: [{
          status: 'in_sync',
          job: { id: 9, name: 'cron-job', category: null, scheduleExpr: '* * * * *', command: 'x', enabled: true, adopted: false, lastResult: 'success', workingDir: null, timeoutSec: null },
          native: {},
        }],
        generatedAt: 0,
      })
      const w = mount(SchedulesView)
      await flushPromises()

      const row = w.findAllComponents({ name: 'JobRow' })[0]!
      row.vm.$emit('edit')
      await flushPromises()

      const editor = w.findComponent({ name: 'JobEditor' })
      expect(editor.props('adopted')).toBe(false)
    })

    it('JobEditor emitting unadopt calls unadoptJob(id) + closes + refreshes + shows success', async () => {
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const adoptedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'in_sync')!
      adoptedRow.vm.$emit('edit')
      await flushPromises()

      const listCallsBefore = listJobs.mock.calls.length
      w.findComponent({ name: 'JobEditor' }).vm.$emit('unadopt')
      await flushPromises()

      expect(unadoptJob).toHaveBeenCalledWith(7)
      expect(listJobs.mock.calls.length).toBeGreaterThan(listCallsBefore)
      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(false)
      expect(w.text()).toContain('Un-adopted')
    })

    it('shows error feedback when unadoptJob throws', async () => {
      unadoptJob.mockRejectedValueOnce(new Error('unadopt failed'))
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const adoptedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'in_sync')!
      adoptedRow.vm.$emit('edit')
      await flushPromises()

      w.findComponent({ name: 'JobEditor' }).vm.$emit('unadopt')
      await flushPromises()

      expect(w.text()).toContain('Un-adopt failed')
    })

    it('shows error and keeps JobEditor open when unadoptJob resolves {ok:false}', async () => {
      unadoptJob.mockResolvedValueOnce({ ok: false, reason: 'drift', error: 'crontab drifted' })
      listJobs.mockResolvedValue(MIXED_RESPONSE)
      const w = mount(SchedulesView)
      await flushPromises()

      const adoptedRow = w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'in_sync')!
      adoptedRow.vm.$emit('edit')
      await flushPromises()

      const listCallsBefore = listJobs.mock.calls.length
      w.findComponent({ name: 'JobEditor' }).vm.$emit('unadopt')
      await flushPromises()

      // Error surfaced
      expect(w.text()).toContain('Un-adopt failed')
      expect(w.text()).toContain('crontab drifted')
      // JobEditor stays open
      expect(w.findComponent({ name: 'JobEditor' }).props('open')).toBe(true)
      // No refresh
      expect(listJobs.mock.calls.length).toBe(listCallsBefore)
    })
  })
})

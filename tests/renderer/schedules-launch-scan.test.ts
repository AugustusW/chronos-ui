// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton } from '../../src/renderer/src/stores/schedule.store'

const managedCount = vi.fn()
const listJobs = vi.fn()
const createJob = vi.fn().mockResolvedValue({ ok: true })
const updateJob = vi.fn().mockResolvedValue({ ok: true })
const adoptJobs = vi.fn().mockResolvedValue({ ok: true, adopted: [] })
const unadoptJob = vi.fn().mockResolvedValue({ ok: true })
const enableJob = vi.fn().mockResolvedValue({ ok: true })
const disableJob = vi.fn().mockResolvedValue({ ok: true })
const deleteJob = vi.fn().mockResolvedValue({ ok: true })
const forgetJob = vi.fn().mockResolvedValue({ ok: true })
const runNowStreaming = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} })
}))

beforeEach(() => {
  managedCount.mockReset()
  listJobs.mockReset()
  createJob.mockReset().mockResolvedValue({ ok: true })
  updateJob.mockReset().mockResolvedValue({ ok: true })
  adoptJobs.mockReset().mockResolvedValue({ ok: true, adopted: [] })
  unadoptJob.mockReset().mockResolvedValue({ ok: true })
  enableJob.mockReset().mockResolvedValue({ ok: true })
  disableJob.mockReset().mockResolvedValue({ ok: true })
  deleteJob.mockReset().mockResolvedValue({ ok: true })
  forgetJob.mockReset().mockResolvedValue({ ok: true })
  runNowStreaming.mockReset().mockResolvedValue(undefined)
  // Assign onto the existing JSDOM window so Event interfaces remain intact (trigger('click') works)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).chronos = {
    managedCount, listJobs, createJob, updateJob,
    adoptJobs, unadoptJob, enableJob, disableJob, deleteJob, forgetJob, runNowStreaming,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).confirm = vi.fn().mockReturnValue(true)
  _resetSingleton()
})

import SchedulesView from '../../src/renderer/src/views/SchedulesView.vue'

describe('SchedulesView — launch-scan behaviour', () => {
  describe('when managedCount returns 0 (first launch, no managed jobs)', () => {
    it('does NOT call listJobs on mount and shows EmptyState', async () => {
      managedCount.mockResolvedValue(0)
      // listJobs should not be called at all on mount when count=0

      const w = mount(SchedulesView)
      await flushPromises()

      expect(managedCount).toHaveBeenCalledTimes(1)
      expect(listJobs).not.toHaveBeenCalled()
      expect(w.findComponent({ name: 'EmptyState' }).exists()).toBe(true)
    })

    it('loading.value is false after mount (no infinite spinner)', async () => {
      managedCount.mockResolvedValue(0)

      const w = mount(SchedulesView)
      await flushPromises()

      // EmptyState receives :scanning="store.loading" — must be false so it renders the Scan button
      const emptyState = w.findComponent({ name: 'EmptyState' })
      expect(emptyState.exists()).toBe(true)
      expect(emptyState.props('scanning')).toBe(false)
    })
  })

  describe('when managedCount returns 2 (returning user with existing jobs)', () => {
    it('calls listJobs on mount and shows the job list', async () => {
      managedCount.mockResolvedValue(2)
      listJobs.mockResolvedValue({
        items: [
          { status: 'in_sync', job: { id: 1, name: 'Alpha', category: 'backups', scheduleExpr: '0 3 * * *', command: '/a.sh', enabled: true, adopted: true, lastResult: 'success' }, native: {} }
        ],
        generatedAt: 0
      })

      const w = mount(SchedulesView)
      await flushPromises()

      expect(managedCount).toHaveBeenCalledTimes(1)
      expect(listJobs).toHaveBeenCalledTimes(1)
      expect(w.text()).toContain('Alpha')
    })
  })

  describe('topbar Scan button', () => {
    it('renders a Scan button in the topbar with data-test="rescan"', async () => {
      managedCount.mockResolvedValue(0)

      const w = mount(SchedulesView)
      await flushPromises()

      const btn = w.find('[data-test="rescan"]')
      expect(btn.exists()).toBe(true)
    })

    it('Scan button calls listJobs (triggers store.refresh → onScan)', async () => {
      managedCount.mockResolvedValue(0)
      listJobs.mockResolvedValue({ items: [], generatedAt: 0 })

      const w = mount(SchedulesView)
      await flushPromises()

      expect(listJobs).not.toHaveBeenCalled() // count=0, no auto-scan

      await w.find('[data-test="rescan"]').trigger('click')
      await flushPromises()

      expect(listJobs).toHaveBeenCalledTimes(1)
    })

    it('Scan button is disabled while store.loading is true', async () => {
      // Arrange: managedCount returns 2, listJobs hangs (loading stays true)
      managedCount.mockResolvedValue(2)
      let resolveList: (() => void) | undefined
      listJobs.mockReturnValue(new Promise<{ items: []; generatedAt: 0 }>((r) => { resolveList = () => r({ items: [], generatedAt: 0 }) }))

      const w = mount(SchedulesView)
      // Allow managedCount to resolve but listJobs to stay pending
      await Promise.resolve()
      await Promise.resolve()
      await w.vm.$nextTick()

      const btn = w.find('[data-test="rescan"]')
      expect(btn.attributes('disabled')).toBeDefined()

      // Cleanup: resolve the pending listJobs to avoid test leaks
      resolveList!()
      await flushPromises()
    })
  })
})

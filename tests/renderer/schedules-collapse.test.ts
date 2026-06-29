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

// Two groups: one managed ("backups") + one unmanaged ("found in crontab")
const TWO_GROUP_RESPONSE = {
  items: [
    {
      status: 'in_sync',
      job: { id: 1, name: 'Alpha', category: 'backups', scheduleExpr: '0 3 * * *', command: '/a.sh', enabled: true, adopted: true, lastResult: 'success', workingDir: null, timeoutSec: null },
      native: {}
    },
    {
      status: 'unmanaged',
      native: { chronosId: null, scheduleExpr: '0 6 * * *', scheduleExprFormat: 'cron', command: '/u.sh', adopted: false, enabled: true }
    }
  ],
  generatedAt: 0
}

beforeEach(() => {
  managedCount.mockReset().mockResolvedValue(2)
  listJobs.mockReset().mockResolvedValue(TWO_GROUP_RESPONSE)
  createJob.mockReset().mockResolvedValue({ ok: true })
  updateJob.mockReset().mockResolvedValue({ ok: true })
  adoptJobs.mockReset().mockResolvedValue({ ok: true, adopted: [] })
  unadoptJob.mockReset().mockResolvedValue({ ok: true })
  enableJob.mockReset().mockResolvedValue({ ok: true })
  disableJob.mockReset().mockResolvedValue({ ok: true })
  deleteJob.mockReset().mockResolvedValue({ ok: true })
  forgetJob.mockReset().mockResolvedValue({ ok: true })
  runNowStreaming.mockReset().mockResolvedValue(undefined)
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

describe('SchedulesView — collapsible group headers', () => {
  it('renders group headers with data-test="ghead" and rows visible by default', async () => {
    const w = mount(SchedulesView)
    await flushPromises()

    const heads = w.findAll('[data-test="ghead"]')
    expect(heads.length).toBeGreaterThanOrEqual(2)

    // Both groups' rows visible initially
    const rows = w.findAllComponents({ name: 'JobRow' })
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('clicking a group header hides that group\'s rows while the other group\'s rows remain', async () => {
    const w = mount(SchedulesView)
    await flushPromises()

    const heads = w.findAll('[data-test="ghead"]')
    expect(heads.length).toBeGreaterThanOrEqual(2)

    // Initially both groups have rows
    expect(w.findAllComponents({ name: 'JobRow' }).length).toBeGreaterThanOrEqual(2)

    // Click first group header to collapse it
    await heads[0].trigger('click')
    await w.vm.$nextTick()

    // After collapse: total rows should be fewer (one group hidden)
    const rowsAfterCollapse = w.findAllComponents({ name: 'JobRow' })
    expect(rowsAfterCollapse.length).toBeLessThan(2)

    // The second group's rows are still there (at least 1 row remains)
    expect(rowsAfterCollapse.length).toBeGreaterThanOrEqual(1)
  })

  it('clicking the collapsed header again re-shows its rows', async () => {
    const w = mount(SchedulesView)
    await flushPromises()

    const heads = w.findAll('[data-test="ghead"]')
    const initialRowCount = w.findAllComponents({ name: 'JobRow' }).length

    // Collapse first group
    await heads[0].trigger('click')
    await w.vm.$nextTick()

    const collapsedRowCount = w.findAllComponents({ name: 'JobRow' }).length
    expect(collapsedRowCount).toBeLessThan(initialRowCount)

    // Expand again
    await heads[0].trigger('click')
    await w.vm.$nextTick()

    expect(w.findAllComponents({ name: 'JobRow' }).length).toBe(initialRowCount)
  })

  it('count chip (.gc) remains visible when a group is collapsed', async () => {
    const w = mount(SchedulesView)
    await flushPromises()

    const heads = w.findAll('[data-test="ghead"]')
    // Collapse first group
    await heads[0].trigger('click')
    await w.vm.$nextTick()

    // The count chip should still be in the DOM inside the (collapsed) header
    const chips = w.findAll('.gc')
    expect(chips.length).toBeGreaterThanOrEqual(1)
  })

  it('group headers have role="button" and tabindex="0" for accessibility', async () => {
    const w = mount(SchedulesView)
    await flushPromises()

    const heads = w.findAll('[data-test="ghead"]')
    for (const head of heads) {
      expect(head.attributes('role')).toBe('button')
      expect(head.attributes('tabindex')).toBe('0')
    }
  })

  it('shows a chevron indicator that changes on collapse/expand', async () => {
    const w = mount(SchedulesView)
    await flushPromises()

    const heads = w.findAll('[data-test="ghead"]')
    const firstHead = heads[0]

    // Expanded: down chevron
    expect(firstHead.text()).toContain('▾')
    expect(firstHead.text()).not.toContain('▸')

    // Collapse
    await firstHead.trigger('click')
    await w.vm.$nextTick()

    // Collapsed: right chevron
    expect(firstHead.text()).toContain('▸')
    expect(firstHead.text()).not.toContain('▾')
  })
})

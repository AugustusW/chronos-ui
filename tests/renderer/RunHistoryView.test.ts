// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetRunHistorySingleton } from '../../src/renderer/src/stores/runHistory.store'

const searchRuns = vi.fn()
const listJobs = vi.fn()

function row(over: Record<string, unknown> = {}) {
  return {
    id: 10, jobId: 1, jobName: 'Backup', triggeredBy: 'schedule', result: 'success',
    startedAt: Date.now() - 1000, endedAt: Date.now(), durationMs: 1200, exitCode: 0,
    stdout: '', stderr: '', createdAt: new Date(),
    ...over
  }
}

beforeEach(() => {
  _resetRunHistorySingleton()
  searchRuns.mockReset()
  listJobs.mockReset()
  searchRuns.mockResolvedValue([row()])
  listJobs.mockResolvedValue({
    items: [
      { status: 'in_sync', job: { id: 1, name: 'Backup' } },
      { status: 'in_sync', job: { id: 2, name: 'Sync' } },
      { status: 'unmanaged', native: { scheduleExpr: '* * * * *', command: 'x' } } // no .job — excluded from the dropdown
    ],
    generatedAt: 0
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  g.window ??= {}
  g.window.chronos = { searchRuns, listJobs }
})

import RunHistoryView from '../../src/renderer/src/views/RunHistoryView.vue'
import SkeletonRows from '../../src/renderer/src/components/SkeletonRows.vue'

describe('RunHistoryView', () => {
  it('fetches with all-time defaults on mount and renders the results', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(searchRuns).toHaveBeenCalledWith({ jobId: undefined, result: undefined, since: undefined, searchText: undefined, limit: 50 })
    expect(w.text()).toContain('schedule')
  })

  it('populates the job dropdown from listJobs, excluding unmanaged (job-less) entries', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    const options = w.find('[data-test="filter-job"]').findAll('option').map((o) => o.text())
    expect(options).toEqual(['All jobs', 'Backup', 'Sync'])
  })

  it('shows the "no runs match" empty message when the result set is empty', async () => {
    searchRuns.mockResolvedValue([])
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(w.text()).toContain('No runs match these filters')
  })

  it('shows an error message when the search fails', async () => {
    searchRuns.mockReset()
    searchRuns.mockRejectedValueOnce(new Error('IPC failure'))
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(w.text()).toContain("Couldn't load runs")
    expect(w.text()).toContain('IPC failure')
  })

  it('shows a skeleton while loading, then clears it', async () => {
    let resolveSearch!: (v: unknown[]) => void
    searchRuns.mockReturnValue(new Promise((res) => { resolveSearch = res }))
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(true)
    resolveSearch([])
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(false)
  })

  it('choosing a job filter re-queries with that jobId', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    searchRuns.mockClear()
    await w.find('[data-test="filter-job"]').setValue('2')
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ jobId: 2 }))
  })

  it('choosing a result filter re-queries with that result', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    searchRuns.mockClear()
    await w.find('[data-test="filter-result"]').setValue('failure')
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ result: 'failure' }))
  })

  it('clicking a date-range preset re-queries with a since bound, and marks the button active', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    searchRuns.mockClear()
    const buttons = w.findAll('[data-test="filter-date"] button')
    const todayBtn = buttons.find((b) => b.text() === 'Today')!
    await todayBtn.trigger('click')
    expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ since: expect.any(Number) }))
    expect(todayBtn.classes()).toContain('active')
  })

  it('typing in the search box eventually re-queries with searchText (debounced)', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(RunHistoryView)
      await flushPromises()
      searchRuns.mockClear()
      await w.find('[data-test="filter-search"]').setValue('backup')
      vi.advanceTimersByTime(300)
      await flushPromises()
      expect(searchRuns).toHaveBeenCalledWith(expect.objectContaining({ searchText: 'backup' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('the Clear button only appears once a filter is active, and resets everything on click', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(w.find('[data-test="filter-clear"]').exists()).toBe(false)
    await w.find('[data-test="filter-result"]').setValue('failure')
    expect(w.find('[data-test="filter-clear"]').exists()).toBe(true)
    searchRuns.mockClear()
    await w.find('[data-test="filter-clear"]').trigger('click')
    expect(searchRuns).toHaveBeenCalledWith({ jobId: undefined, result: undefined, since: undefined, searchText: undefined, limit: 50 })
    expect(w.find('[data-test="filter-clear"]').exists()).toBe(false)
  })

  it('shows a "Load 50 more" button only when the result count fills a full page, and it fetches more on click', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => row({ id: i + 1 }))
    searchRuns.mockResolvedValue(fullPage)
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(w.find('[data-test="load-more"]').exists()).toBe(true)

    searchRuns.mockResolvedValueOnce([...fullPage, row({ id: 999 })])
    await w.find('[data-test="load-more"]').trigger('click')
    await flushPromises()
    expect(searchRuns).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }))
  })

  it('renders the job name per row (RunHistoryList extension)', async () => {
    const w = mount(RunHistoryView)
    await flushPromises()
    expect(w.find('[data-test="run-job-name"]').text()).toBe('Backup')
  })
})

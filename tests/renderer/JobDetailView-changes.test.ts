// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The Changes tab's wiring: it must not fetch history until it is opened, it must survive a
// failing fetch, and — the part that actually matters — a revert must go through the ordinary
// update path and must SAY when it could not restore everything.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} })
}))

const listRuns = vi.fn()
const jobRunDurationTrend = vi.fn()
const listRevisions = vi.fn()
const updateJob = vi.fn()
const enableJob = vi.fn()
const disableJob = vi.fn()
const restoreToScheduler = vi.fn()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rev = (over: any = {}): any => ({
  id: 1, jobId: 1, changedAt: new Date(), source: 'edit',
  changedFields: ['command'], before: { command: '/usr/bin/old.sh' }, after: { command: '/usr/bin/new.sh' },
  ...over
})

beforeEach(() => {
  for (const m of [listRuns, jobRunDurationTrend, listRevisions, updateJob, enableJob, disableJob, restoreToScheduler]) m.mockReset()
  listRuns.mockResolvedValue([])
  jobRunDurationTrend.mockResolvedValue([])
  listRevisions.mockResolvedValue([rev()])
  updateJob.mockResolvedValue({ ok: true })
  enableJob.mockResolvedValue({ ok: true })
  disableJob.mockResolvedValue({ ok: true })
  restoreToScheduler.mockResolvedValue({ ok: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  g.window ??= {}
  g.window.chronos = { listRuns, jobRunDurationTrend, listRevisions, updateJob, enableJob, disableJob, restoreToScheduler, reconcile: vi.fn().mockResolvedValue({ items: [], generatedAt: 0 }) }
})

import JobDetailView from '../../src/renderer/src/views/JobDetailView.vue'

async function openChanges() {
  const w = mount(JobDetailView, { props: { id: '1' } })
  await flushPromises()
  await w.find('[data-test="tab-changes"]').trigger('click')
  await flushPromises()
  return w
}

describe('JobDetailView — Changes tab', () => {
  it('does not fetch history until the tab is opened', async () => {
    mount(JobDetailView, { props: { id: '1' } })
    await flushPromises()
    expect(listRevisions).not.toHaveBeenCalled()
  })

  it('loads and renders history when the tab is opened', async () => {
    const w = await openChanges()
    // PAGE + 1: asking for one more than is shown is how truncation is detected without claiming
    // it for a job that has exactly a page of changes and nothing older.
    expect(listRevisions).toHaveBeenCalledWith(1, 201)
    expect(w.text()).toContain('/usr/bin/old.sh')
  })

  it('shows an error instead of an empty list when the fetch fails', async () => {
    listRevisions.mockRejectedValue(new Error('db gone'))
    const w = await openChanges()
    expect(w.text()).toContain("Couldn't load changes")
    expect(w.text()).toContain('db gone')
  })

  it('reverts through the ordinary update path with the old values', async () => {
    const w = await openChanges()
    await w.find('[data-test="revert"]').trigger('click')
    await flushPromises()
    expect(updateJob).toHaveBeenCalledWith(1, { command: '/usr/bin/old.sh' })
    expect(w.find('[data-test="revert-status"]').text()).toBe('Reverted')
  })

  it('uses enable/disable — not update — to revert an enabled change', async () => {
    listRevisions.mockResolvedValue([rev({ changedFields: ['enabled'], before: { enabled: false }, after: { enabled: true } })])
    const w = await openChanges()
    await w.find('[data-test="revert"]').trigger('click')
    await flushPromises()
    expect(disableJob).toHaveBeenCalledWith(1)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('surfaces the adapter refusal instead of claiming success', async () => {
    updateJob.mockResolvedValue({ ok: false, reason: 'error', error: 'cannot change command of an adopted job; unadopt then adopt' })
    const w = await openChanges()
    await w.find('[data-test="revert"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="revert-status"]').text()).toContain('cannot change command of an adopted job')
  })

  it('says what it could NOT restore rather than reporting a clean revert', async () => {
    listRevisions.mockResolvedValue([
      rev({ changedFields: ['command', 'workingDir'], before: { command: '/usr/bin/old.sh', workingDir: null }, after: {} })
    ])
    const w = await openChanges()
    await w.find('[data-test="revert"]').trigger('click')
    await flushPromises()
    const status = w.find('[data-test="revert-status"]').text()
    expect(status).toContain('workingDir')
    expect(status).not.toBe('Reverted')
  })

  it('renders the empty state when a job has no recorded changes', async () => {
    listRevisions.mockResolvedValue([])
    const w = await openChanges()
    expect(w.text()).toContain('No configuration changes recorded')
  })
})

describe('JobDetailView — restoring a change made outside the app', () => {
  it('pushes the DB values to the scheduler instead of going through update', async () => {
    listRevisions.mockResolvedValue([rev({ source: 'external' })])
    const w = mount(JobDetailView, { props: { id: '1' } })
    await flushPromises()
    await w.find('[data-test="tab-changes"]').trigger('click')
    await flushPromises()

    await w.find('[data-test="restore"]').trigger('click')
    await flushPromises()
    expect(restoreToScheduler).toHaveBeenCalledWith(1)
    // update() would have compared the old values against the DB row, skipped the scheduler, and
    // reported success while the foreign entry kept running.
    expect(updateJob).not.toHaveBeenCalled()
    expect(w.find('[data-test="revert-status"]').text()).toBe('Restored in the scheduler')
  })

  it('reports the adapter refusal when restoring an adopted job', async () => {
    listRevisions.mockResolvedValue([rev({ source: 'external' })])
    restoreToScheduler.mockResolvedValue({ ok: false, reason: 'error', error: 'cannot change command of an adopted job; unadopt then adopt' })
    const w = mount(JobDetailView, { props: { id: '1' } })
    await flushPromises()
    await w.find('[data-test="tab-changes"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="restore"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="revert-status"]').text()).toContain('Restore failed')
  })
})

describe('JobDetailView — history page size', () => {
  it('shows the truncation notice only when there is more than a page', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => rev({ id: i + 1 }))
    listRevisions.mockResolvedValue(page(200))
    let w = mount(JobDetailView, { props: { id: '1' } })
    await flushPromises()
    await w.find('[data-test="tab-changes"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="revisions-truncated"]').exists()).toBe(false)

    listRevisions.mockResolvedValue(page(201))
    w = mount(JobDetailView, { props: { id: '1' } })
    await flushPromises()
    await w.find('[data-test="tab-changes"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="revisions-truncated"]').exists()).toBe(true)
    expect(w.findAll('[data-revision-id]')).toHaveLength(200) // the extra one is not rendered
  })
})

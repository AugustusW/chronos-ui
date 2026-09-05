// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton } from '../../src/renderer/src/stores/schedule.store'
import SettingsView from '../../src/renderer/src/views/SettingsView.vue'

const teardown = vi.fn()
const listJobs = vi.fn()

/** A managed job as reconcile reports it: `job` is the DB row, `adopted` says whether it was wrapped. */
const item = (id: number, adopted: boolean) => ({
  status: 'in_sync',
  job: { id, name: `job${id}`, adopted, scheduleExpr: '0 3 * * *', command: `/j${id}.sh` }
})

beforeEach(() => {
  vi.clearAllMocks()
  _resetSingleton()
  teardown.mockResolvedValue({ ok: true, released: [], skipped: [], deleteFailed: [] })
  listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
  // Extend (not replace) the jsdom window — replacing it wipes native constructors that
  // @vue/test-utils' trigger() needs. Same pattern as DashboardView.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window.chronos = {
    teardown,
    listJobs,
    getNotifySettings: vi.fn().mockResolvedValue({}),
    pgGetStatus: vi.fn().mockResolvedValue({ backend: 'sqlite' })
  }
})

async function openDialog(items: ReturnType<typeof item>[]) {
  listJobs.mockResolvedValue({ items, generatedAt: 0 })
  const w = mount(SettingsView)
  await flushPromises()
  await w.find('[data-teardown-open]').trigger('click')
  await flushPromises()
  return w
}

describe('SettingsView teardown', () => {
  it('counts come from the real job list, not from a hardcoded string', async () => {
    const w = await openDialog([item(1, true), item(2, true), item(3, false)])
    expect(w.find('[data-teardown-adopted]').text()).toContain('2')
    expect(w.find('[data-teardown-created]').text()).toContain('1')
  })

  it('scans before showing counts, so an unvisited Settings never claims "0 jobs"', async () => {
    await openDialog([item(1, true)])
    // hasScanned was false on mount, so opening the dialog must have triggered the scan itself.
    expect(listJobs).toHaveBeenCalled()
  })

  it('says so plainly when nothing is managed', async () => {
    const w = await openDialog([])
    expect(w.find('[data-teardown-none]').exists()).toBe(true)
  })

  it('states that the action cannot be undone', async () => {
    const w = await openDialog([item(1, true)])
    expect(w.find('[data-teardown-irreversible]').text()).toMatch(/cannot be undone/i)
  })

  it('the delete-data checkbox defaults to unchecked', async () => {
    const w = await openDialog([item(1, true)])
    const box = w.find('[data-teardown-delete-data]').element as HTMLInputElement
    expect(box.checked).toBe(false)
  })

  it('cancelling fires no IPC at all', async () => {
    const w = await openDialog([item(1, true)])
    await w.find('[data-teardown-cancel]').trigger('click')
    await flushPromises()
    expect(teardown).not.toHaveBeenCalled()
  })

  it('confirming passes the checkbox value through', async () => {
    const w = await openDialog([item(1, true)])
    await w.find('[data-teardown-delete-data]').setValue(true)
    await w.find('[data-teardown-confirm]').trigger('click')
    await flushPromises()
    expect(teardown).toHaveBeenCalledWith(true)
  })

  it('does not carry a checked box into the next opening', async () => {
    const w = await openDialog([item(1, true)])
    await w.find('[data-teardown-delete-data]').setValue(true)
    await w.find('[data-teardown-cancel]').trigger('click')
    await flushPromises()
    await w.find('[data-teardown-open]').trigger('click')
    await flushPromises()
    const box = w.find('[data-teardown-delete-data]').element as HTMLInputElement
    expect(box.checked).toBe(false)
  })

  it('surfaces a failure instead of pretending it worked', async () => {
    teardown.mockResolvedValue({ ok: false, error: 'the crontab changed underneath us', released: [], skipped: [], deleteFailed: [] })
    const w = await openDialog([item(1, true)])
    await w.find('[data-teardown-confirm]').trigger('click')
    await flushPromises()
    expect(w.find('[data-teardown-error]').text()).toContain('changed underneath us')
  })
})

describe('SettingsView teardown outcome reporting', () => {
  it('reports jobs that were already gone rather than staying silent', async () => {
    teardown.mockResolvedValue({
      ok: true, released: [1], skipped: [{ chronosId: 2, reason: 'no_match' }], deleteFailed: []
    })
    const w = await openDialog([item(1, true), item(2, true)])
    await w.find('[data-teardown-confirm]').trigger('click')
    await flushPromises()
    expect(w.find('[data-teardown-notice]').text()).toMatch(/already gone/i)
  })

  it('names the files it could not delete, so they can be removed by hand', async () => {
    teardown.mockResolvedValue({
      ok: true, released: [1], skipped: [], deleteFailed: ['/userData/chronos.db']
    })
    const w = await openDialog([item(1, true)])
    await w.find('[data-teardown-confirm]').trigger('click')
    await flushPromises()
    expect(w.find('[data-teardown-notice]').text()).toContain('/userData/chronos.db')
  })

  it('shows nothing extra on a fully clean run (the app is quitting anyway)', async () => {
    const w = await openDialog([item(1, true)])
    await w.find('[data-teardown-confirm]').trigger('click')
    await flushPromises()
    expect(w.find('[data-teardown-notice]').exists()).toBe(false)
  })
})

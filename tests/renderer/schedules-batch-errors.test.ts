// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
//
// Enable and Disable exist ONLY as Select-mode batch actions. They used to discard every result,
// so a refusal the adapter had worded carefully ("ambiguous marker chronos:2 — \A, \B") and a
// write that actually went through were indistinguishable on screen.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton, useScheduleStore } from '../../src/renderer/src/stores/schedule.store'

const listJobs = vi.fn()
const enableJob = vi.fn()
const managedCount = vi.fn()
const noop = vi.fn().mockResolvedValue({ ok: true })

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ params: {} }) }))

const MANAGED = {
  items: [
    { status: 'in_sync', job: { id: 1, name: 'First Task', category: null, scheduleExpr: 'daily 04:00', command: 'y', enabled: true, adopted: true, lastResult: 'success' }, native: {} },
    { status: 'in_sync', job: { id: 2, name: 'Second Task', category: null, scheduleExpr: 'daily 03:00', command: 'x', enabled: true, adopted: true, lastResult: 'success' }, native: {} }
  ],
  generatedAt: 0
}

beforeEach(() => {
  managedCount.mockReset().mockResolvedValue(2)
  listJobs.mockReset().mockResolvedValue(MANAGED)
  enableJob.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = {
    chronos: {
      platform: 'win32',
      managedCount, listJobs, adoptJobs: noop,
      unadoptJob: noop, createJob: noop, updateJob: noop,
      enableJob, disableJob: noop, deleteJob: noop, runNowStreaming: noop
    },
    confirm: () => true
  }
  _resetSingleton()
})

import SchedulesView from '../../src/renderer/src/views/SchedulesView.vue'

/** Select the rows, then let the batch bar emit `enable` the way its button does. */
async function runEnable(ids: number[]): Promise<string> {
  const store = useScheduleStore()
  store.selectMode = true
  ids.forEach((id) => store.toggleSelect(id))
  await flushPromises()
  const w = mount(SchedulesView)
  await flushPromises()
  w.findComponent({ name: 'BatchActionBar' }).vm.$emit('enable')
  await flushPromises()
  return w.text()
}

describe('a batch write says what happened', () => {
  it('shows the adapter’s reason when one job is refused', async () => {
    enableJob.mockImplementation(async (id: number) =>
      id === 2
        ? { ok: false, reason: 'error', error: 'ambiguous marker chronos:2 — \\ChronosVerify\\Second Task, \\ChronosVerify\\Second Task COPY' }
        : { ok: true }
    )
    mount(SchedulesView)
    await flushPromises()
    const text = await runEnable([1, 2])
    expect(text).toContain('ambiguous marker chronos:2')
  })

  it('does not stop at the first refusal', async () => {
    enableJob.mockImplementation(async (id: number) => (id === 2 ? { ok: false, error: 'nope' } : { ok: true }))
    mount(SchedulesView)
    await flushPromises()
    await runEnable([1, 2])
    // Both were attempted. One job that cannot be written must not strand the others.
    expect(enableJob).toHaveBeenCalledTimes(2)
  })

  it('says so plainly when every job went through', async () => {
    enableJob.mockResolvedValue({ ok: true })
    mount(SchedulesView)
    await flushPromises()
    const text = await runEnable([1, 2])
    expect(text).toContain('Enabled 2 job(s)')
    expect(text).not.toContain('failed')
  })
})

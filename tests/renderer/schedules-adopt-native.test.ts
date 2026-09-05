// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton } from '../../src/renderer/src/stores/schedule.store'

const managedCount = vi.fn()
const listJobs = vi.fn()
const adoptJobs = vi.fn()
const noop = vi.fn().mockResolvedValue({ ok: true })

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ params: {} }) }))

beforeEach(() => {
  managedCount.mockReset().mockResolvedValue(1)
  listJobs.mockReset()
  adoptJobs.mockReset().mockResolvedValue({ ok: true, adopted: [1] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = {
    chronos: {
      platform: 'win32',
      managedCount, listJobs, adoptJobs,
      unadoptJob: noop, createJob: noop, updateJob: noop,
      enableJob: noop, disableJob: noop, deleteJob: noop, runNowStreaming: noop
    }
  }
  _resetSingleton()
})

import SchedulesView from '../../src/renderer/src/views/SchedulesView.vue'

const UNMANAGED = {
  items: [
    {
      status: 'unmanaged',
      native: {
        chronosId: null,
        scheduleExpr: 'daily 03:00',
        scheduleExprFormat: 'win-trigger',
        command: 'C:\\Backup\\backup.exe -full',
        adopted: false,
        enabled: true,
        canAdopt: true,
        name: 'Nightly Backup',
        nativePath: '\\Custom\\'
      }
    }
  ],
  generatedAt: 0
}

describe('adopting sends the task its own identity', () => {
  it('sends the scheduler’s name and folder, not the name the user typed', async () => {
    // Both are called "name" and they mean different things: one is what the job will be called in
    // ChronosUI and is edited in the dialog, the other is how Windows identifies the task and is
    // never edited. Crossing them would make the adapter look for a task named after the user's
    // label — the same class of mistake as looking for one named after the database id.
    listJobs.mockResolvedValue(UNMANAGED)
    const w = mount(SchedulesView)
    await flushPromises()

    w.findAllComponents({ name: 'JobRow' }).find((r) => r.props('item').status === 'unmanaged')!.vm.$emit('adopt')
    await flushPromises()
    w.findComponent({ name: 'AdoptDialog' }).vm.$emit('adopt', { name: 'My backup' })
    await flushPromises()

    expect(adoptJobs).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'My backup',
        native: { name: 'Nightly Backup', path: '\\Custom\\' }
      })
    ])
  })
})

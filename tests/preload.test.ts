// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'

// Capture what preload exposes by mocking electron's contextBridge + ipcRenderer.
const exposed: Record<string, unknown> = {}
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, api: Record<string, unknown>) => { Object.assign(exposed, { [k]: api }) } },
  ipcRenderer: { invoke: vi.fn(async () => undefined), on: vi.fn(), removeListener: vi.fn() }
}))

describe('preload chronos api', () => {
  it('exposes every Plan 5 method on window.chronos', async () => {
    await import('../src/preload/index')
    const api = exposed.chronos as Record<string, unknown>
    for (const m of ['getVersion', 'listJobs', 'reconcile', 'createJob', 'updateJob', 'enableJob', 'disableJob', 'deleteJob', 'adoptJobs', 'unadoptJob', 'runNow', 'listRuns']) {
      expect(typeof api[m]).toBe('function')
    }
  })
  it('exposes the Plan 6 live-run methods', async () => {
    await import('../src/preload/index')
    const api = exposed.chronos as Record<string, unknown>
    for (const m of ['onRunEvent', 'cancelBatch', 'runNowStreaming']) expect(typeof api[m]).toBe('function')
  })
  it('exposes recentRuns as a function (FU5)', async () => {
    await import('../src/preload/index')
    const api = exposed.chronos as Record<string, unknown>
    expect(typeof api.recentRuns).toBe('function')
  })
  it('onRunEvent registers and unregisters the SAME handler reference', async () => {
    const { ipcRenderer } = await import('electron')
    const { on, removeListener } = ipcRenderer as unknown as { on: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> }
    await import('../src/preload/index')
    const api = exposed.chronos as Record<string, (cb: () => void) => () => void>
    on.mockClear(); removeListener.mockClear()
    const cb = vi.fn()
    const unsub = api.onRunEvent(cb)
    expect(on).toHaveBeenCalledOnce()
    expect(on.mock.calls[0][0]).toBe('run:event')
    const registeredH = on.mock.calls[0][1]
    unsub()
    expect(removeListener).toHaveBeenCalledOnce()
    expect(removeListener.mock.calls[0][1]).toBe(registeredH)
  })
})

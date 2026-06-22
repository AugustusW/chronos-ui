// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { startRunEventBridge } from '../../src/renderer/src/ipc/events'

describe('startRunEventBridge', () => {
  it('subscribes once and forwards events to the store reducer', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let handler: ((e: any) => void) | null = null
    const unsub = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { chronos: { onRunEvent: (cb: any) => { handler = cb; return unsub } } }
    const store = { applyRunEvent: vi.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stop = startRunEventBridge(store as any)
    handler!({ kind: 'jobsChanged' })
    expect(store.applyRunEvent).toHaveBeenCalledWith({ kind: 'jobsChanged' })
    stop(); expect(unsub).toHaveBeenCalled()
  })
})

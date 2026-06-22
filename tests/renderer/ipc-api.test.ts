// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// NOTE: this test runs in the default node environment (no jsdom).
// We manually set globalThis.window to simulate the renderer context.

describe('ipc/api lazy Proxy', () => {
  // Save and restore globalThis.window around each test
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalWindow: any

  beforeEach(() => {
    originalWindow = (globalThis as { window?: unknown }).window
  })

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
    vi.resetModules()
  })

  it('delegates method calls to window.chronos at call time (lazy)', async () => {
    const listRuns = vi.fn().mockResolvedValue([])
    // Set window.chronos AFTER the module is imported — this is the key assertion:
    // with the eager impl, api was captured as undefined at import, so this would fail.
    ;(globalThis as { window?: unknown }).window = { chronos: { listRuns } }

    // Import the module — the lazy Proxy should NOT capture at import time
    const { api } = await import('../../src/renderer/src/ipc/api')

    // Call via the proxy — it must delegate to the current window.chronos.listRuns
    await api.listRuns(1 as Parameters<typeof api.listRuns>[0])
    expect(listRuns).toHaveBeenCalledWith(1)
  })

  it('reflects window.chronos set AFTER import (lazy binding)', async () => {
    // Start with no window
    delete (globalThis as { window?: unknown }).window

    const { api } = await import('../../src/renderer/src/ipc/api')

    // Now set window.chronos after import
    const listRuns = vi.fn().mockResolvedValue([42])
    ;(globalThis as { window?: unknown }).window = { chronos: { listRuns } }

    await api.listRuns(5 as Parameters<typeof api.listRuns>[0])
    expect(listRuns).toHaveBeenCalledWith(5)
  })

  it('does NOT throw when imported with no window (import-safe)', async () => {
    delete (globalThis as { window?: unknown }).window
    // This should NOT throw — import-safe is the contract
    await expect(import('../../src/renderer/src/ipc/api')).resolves.toBeDefined()
  })

  it('returns undefined for any prop when window.chronos is absent', async () => {
    delete (globalThis as { window?: unknown }).window
    const { api } = await import('../../src/renderer/src/ipc/api')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((api as any).listRuns).toBeUndefined()
  })
})

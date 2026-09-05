// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { createQuitGuard } from '../src/main/quit-guard'

describe('quit guard', () => {
  it('intercepts a window close on win32/linux until a quit is requested', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const g = createQuitGuard({ quit: vi.fn(), platform })
      expect(g.shouldInterceptClose()).toBe(true)
      g.requestQuit()
      expect(g.shouldInterceptClose()).toBe(false)
    }
  })

  it('never intercepts on darwin, quit requested or not', () => {
    const g = createQuitGuard({ quit: vi.fn(), platform: 'darwin' })
    expect(g.shouldInterceptClose()).toBe(false)
    g.requestQuit()
    expect(g.shouldInterceptClose()).toBe(false)
  })

  it('requestQuit marks the intent BEFORE calling quit', () => {
    // If quit() ran first, Electron could fire the close handler while the flag was still false —
    // exactly the zombie this unit exists to prevent.
    let interceptDuringQuit: boolean | null = null
    const g = createQuitGuard({
      platform: 'win32',
      quit: () => {
        interceptDuringQuit = g.shouldInterceptClose()
      }
    })
    g.requestQuit()
    expect(interceptDuringQuit).toBe(false)
  })

  it('calls the injected quit exactly once per request', () => {
    const quit = vi.fn()
    const g = createQuitGuard({ quit, platform: 'win32' })
    g.requestQuit()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

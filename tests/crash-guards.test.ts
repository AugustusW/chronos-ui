// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { installCrashGuards } from '../src/main/crash-guards'

function fakeEmitter(): { on: (ev: string, cb: (...a: unknown[]) => void) => void; handlers: Record<string, (...a: unknown[]) => void> } {
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  return { on: (ev, cb) => { handlers[ev] = cb }, handlers }
}

describe('installCrashGuards', () => {
  it('registers uncaughtException + unhandledRejection on process and render-process-gone on app', () => {
    const proc = fakeEmitter()
    const app = fakeEmitter()
    installCrashGuards({ process: proc, app, log: vi.fn(), showError: vi.fn() })
    expect(typeof proc.handlers['uncaughtException']).toBe('function')
    expect(typeof proc.handlers['unhandledRejection']).toBe('function')
    expect(typeof app.handlers['render-process-gone']).toBe('function')
  })

  it('SHOWS the error (with stack) and does NOT rethrow when an uncaught exception fires (dev-facing)', () => {
    const proc = fakeEmitter()
    const app = fakeEmitter()
    const showError = vi.fn()
    installCrashGuards({ process: proc, app, log: vi.fn(), showError })
    const err = new Error('boom-detail')
    expect(() => proc.handlers['uncaughtException'](err)).not.toThrow()
    expect(showError).toHaveBeenCalledTimes(1)
    const [title, content] = showError.mock.calls[0]
    expect(title).toContain('uncaughtException')
    expect(content).toContain('boom-detail') // the actual message must be visible to the developer
  })

  it('surfaces an unhandled rejection reason in the dialog content', () => {
    const proc = fakeEmitter()
    const app = fakeEmitter()
    const showError = vi.fn()
    installCrashGuards({ process: proc, app, log: vi.fn(), showError })
    proc.handlers['unhandledRejection']('rejection-reason-xyz')
    expect(showError.mock.calls[0][0]).toContain('unhandledRejection')
    expect(showError.mock.calls[0][1]).toContain('rejection-reason-xyz')
  })

  it('also logs every event (for the record) without throwing', () => {
    const proc = fakeEmitter()
    const app = fakeEmitter()
    const log = vi.fn()
    installCrashGuards({ process: proc, app, log, showError: vi.fn() })
    proc.handlers['uncaughtException'](new Error('x'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('uncaughtException'), expect.any(Error))
  })

  it('surfaces render-process-gone with the details object ({reason, exitCode})', () => {
    const proc = fakeEmitter()
    const app = fakeEmitter()
    const showError = vi.fn()
    installCrashGuards({ process: proc, app, log: vi.fn(), showError })
    app.handlers['render-process-gone']('event', 'webContents', { reason: 'crashed', exitCode: -1 })
    expect(showError.mock.calls[0][0]).toContain('render-process-gone')
    expect(showError.mock.calls[0][1]).toContain('crashed')
  })

  it('does NOT re-enter report() if showError itself triggers another event (no infinite loop)', () => {
    const proc = fakeEmitter()
    const app = fakeEmitter()
    let calls = 0
    const showError = vi.fn(() => {
      calls++
      // Simulate showError throwing → Node would fire another uncaughtException synchronously.
      if (calls < 10) proc.handlers['uncaughtException'](new Error('nested'))
    })
    installCrashGuards({ process: proc, app, log: vi.fn(), showError })
    proc.handlers['uncaughtException'](new Error('first'))
    expect(calls).toBe(1) // reentrancy guard blocked the nested report
  })
})

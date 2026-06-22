// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { makeRunEmitter } from '../../src/main/runner/run-emitter'

describe('makeRunEmitter', () => {
  it('sends when the webContents is alive', () => {
    const send = vi.fn()
    const emit = makeRunEmitter(() => ({ isDestroyed: () => false, send }) as never)
    emit({ kind: 'jobsChanged' })
    expect(send).toHaveBeenCalledWith('run:event', { kind: 'jobsChanged' })
  })
  it('is a no-op when the webContents is gone (architect HIGH-1)', () => {
    const send = vi.fn()
    const emit = makeRunEmitter(() => ({ isDestroyed: () => true, send }) as never)
    emit({ kind: 'jobsChanged' })
    expect(send).not.toHaveBeenCalled()
  })
  it('is a no-op when there is no window', () => {
    const emit = makeRunEmitter(() => undefined)
    expect(() => emit({ kind: 'jobsChanged' })).not.toThrow()
  })
})

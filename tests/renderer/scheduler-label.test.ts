// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest'
import { schedulerLabel, hostPlatform } from '../../src/renderer/src/lib/scheduler-label'

describe('schedulerLabel', () => {
  it('win32 → Task Scheduler', () => expect(schedulerLabel('win32')).toBe('Task Scheduler'))
  it('darwin → crontab', () => expect(schedulerLabel('darwin')).toBe('crontab'))
  it('linux → crontab', () => expect(schedulerLabel('linux')).toBe('crontab'))
})

describe('hostPlatform', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  afterEach(() => { delete (globalThis as any).window })
  it('reads the platform exposed by preload on window.chronos', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { chronos: { platform: 'win32' } }
    expect(hostPlatform()).toBe('win32')
  })
  it('falls back to darwin when the bridge is not present yet', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = undefined
    expect(hostPlatform()).toBe('darwin')
  })
})

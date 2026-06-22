// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  CrontabAdapter,
  makeCrontabExec,
  TaskSchedulerAdapter,
  makePowerShellExec,
  normalizeTaskXml,
  winQuoteArg,
  parseTriggerDescriptor,
  buildDescription,
  type SchedulerAdapter,
  type ExecFn
} from '../../src/main/scheduler'

describe('scheduler barrel', () => {
  it('re-exports both adapters, their exec factories, and the Windows helpers', () => {
    expect(typeof CrontabAdapter).toBe('function')
    expect(typeof makeCrontabExec).toBe('function')
    expect(typeof TaskSchedulerAdapter).toBe('function')
    expect(typeof makePowerShellExec).toBe('function')
    expect(typeof winQuoteArg).toBe('function')
    expect(typeof parseTriggerDescriptor).toBe('function')
    expect(typeof buildDescription).toBe('function')
    expect(typeof normalizeTaskXml).toBe('function')
    const _a: SchedulerAdapter | null = null
    const _e: ExecFn | null = null
    expect(_a).toBeNull()
    expect(_e).toBeNull()
  })
})

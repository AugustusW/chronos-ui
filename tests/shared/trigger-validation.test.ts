// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  validateTriggerDescriptor,
  describeTriggerDescriptor,
  TRIGGER_DESCRIPTOR_EXAMPLE
} from '../../src/shared/trigger-validation'

describe('validateTriggerDescriptor', () => {
  it('accepts every documented form', () => {
    for (const s of [
      'daily 03:00',
      'weekly MON,WED,FRI 07:30',
      'hourly 2',
      'minutes 15',
      'onlogon',
      'onstart',
      'once 2026-12-25T09:00'
    ]) {
      expect(validateTriggerDescriptor(s), s).toBeNull()
    }
  })

  it('names cron specifically instead of repeating the parser error', () => {
    // The whole defect: the editor asked for a cron expression, the Windows adapter does not take
    // one, and the user was shown `trigger: unknown kind 0` — the leading field of their own cron
    // line, echoed back as if it were a typo. Saying "that is cron, here is what this machine
    // wants" is the difference between a dead end and a next step.
    const msg = validateTriggerDescriptor('0 3 * * *')
    expect(msg).toMatch(/cron/i)
    expect(msg).toContain(TRIGGER_DESCRIPTOR_EXAMPLE)
    expect(msg).not.toMatch(/unknown kind/)
  })

  it('rejects an empty schedule with a message, not a crash', () => {
    expect(validateTriggerDescriptor('')).toMatch(/schedule/i)
    expect(validateTriggerDescriptor('   ')).toMatch(/schedule/i)
  })

  it('surfaces the specific problem for a near-miss, not a generic complaint', () => {
    expect(validateTriggerDescriptor('daily 25:00')).toMatch(/25:00/)
    expect(validateTriggerDescriptor('daily')).toMatch(/HH:MM/)
    expect(validateTriggerDescriptor('weekly XXX 09:00')).toMatch(/XXX/)
    expect(validateTriggerDescriptor('hourly nope')).toMatch(/positive integer/i)
  })
})

describe('describeTriggerDescriptor', () => {
  it('renders each kind in plain language', () => {
    expect(describeTriggerDescriptor('daily 03:00')).toBe('Every day at 03:00')
    expect(describeTriggerDescriptor('weekly MON,FRI 07:30')).toBe('Every Monday and Friday at 07:30')
    expect(describeTriggerDescriptor('weekly MON,WED,FRI 07:30')).toBe('Every Monday, Wednesday and Friday at 07:30')
    expect(describeTriggerDescriptor('hourly 1')).toBe('Every hour')
    expect(describeTriggerDescriptor('hourly 3')).toBe('Every 3 hours')
    expect(describeTriggerDescriptor('minutes 1')).toBe('Every minute')
    expect(describeTriggerDescriptor('minutes 15')).toBe('Every 15 minutes')
    expect(describeTriggerDescriptor('onlogon')).toBe('When you sign in')
    expect(describeTriggerDescriptor('onstart')).toBe('When the computer starts')
    expect(describeTriggerDescriptor('once 2026-12-25T09:00')).toBe('Once, on 2026-12-25 at 09:00')
  })

  it('returns null rather than throwing on input the field is still being typed into', () => {
    expect(describeTriggerDescriptor('dail')).toBeNull()
    expect(describeTriggerDescriptor('')).toBeNull()
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import {
  parseTriggerDescriptor,
  triggerSpecToDescriptor,
  triggerSpecToPwsh,
  cimTriggerToDescriptor
} from '../../src/main/scheduler/trigger-model'

describe('trigger descriptor parse/serialize', () => {
  const cases = ['daily 03:00', 'weekly MON,WED,FRI 09:30', 'minutes 5', 'hourly 2', 'onlogon', 'onstart', 'once 2026-07-01T08:00']

  it('round-trips every supported descriptor', () => {
    for (const c of cases) {
      expect(triggerSpecToDescriptor(parseTriggerDescriptor(c)), c).toBe(c)
    }
  })

  it('parses fields correctly', () => {
    expect(parseTriggerDescriptor('daily 03:00')).toEqual({ kind: 'daily', at: '03:00' })
    expect(parseTriggerDescriptor('weekly mon,fri 09:30')).toEqual({ kind: 'weekly', days: ['MON', 'FRI'], at: '09:30' })
    expect(parseTriggerDescriptor('minutes 15')).toEqual({ kind: 'minutes', every: 15 })
  })

  it('rejects malformed descriptors (never silently coerces)', () => {
    expect(() => parseTriggerDescriptor('daily 25:00')).toThrow()
    expect(() => parseTriggerDescriptor('weekly XYZ 09:00')).toThrow()
    expect(() => parseTriggerDescriptor('minutes 0')).toThrow()
    expect(() => parseTriggerDescriptor('monthly 1 03:00')).toThrow() // monthly is a v1 gap
    expect(() => parseTriggerDescriptor('bogus')).toThrow()
  })
})

describe('triggerSpecToPwsh', () => {
  it('emits New-ScheduledTaskTrigger expressions', () => {
    expect(triggerSpecToPwsh({ kind: 'daily', at: '03:00' })).toBe("New-ScheduledTaskTrigger -Daily -At '03:00'")
    expect(triggerSpecToPwsh({ kind: 'weekly', days: ['MON', 'WED'], at: '09:30' })).toBe(
      "New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Wednesday -At '09:30'"
    )
    expect(triggerSpecToPwsh({ kind: 'minutes', every: 5 })).toContain('-RepetitionInterval (New-TimeSpan -Minutes 5)')
    expect(triggerSpecToPwsh({ kind: 'onlogon' })).toBe('New-ScheduledTaskTrigger -AtLogOn')
    expect(triggerSpecToPwsh({ kind: 'onstart' })).toBe('New-ScheduledTaskTrigger -AtStartup')
  })
})

describe('cimTriggerToDescriptor (best-effort read-back of pre-existing tasks)', () => {
  it('maps the common CIM trigger classes', () => {
    expect(cimTriggerToDescriptor({ CimClass: 'MSFT_TaskDailyTrigger', StartBoundary: '2026-01-01T03:00:00' })).toEqual({
      descriptor: 'daily 03:00',
      lossy: false
    })
    expect(cimTriggerToDescriptor({ CimClass: 'MSFT_TaskWeeklyTrigger', StartBoundary: '2026-01-01T09:30:00', DaysOfWeek: 2 | 8 })).toEqual({
      descriptor: 'weekly MON,WED 09:30',
      lossy: false
    })
    expect(cimTriggerToDescriptor({ CimClass: 'MSFT_TaskLogonTrigger' })).toEqual({ descriptor: 'onlogon', lossy: false })
    expect(cimTriggerToDescriptor({ CimClass: 'MSFT_TaskTimeTrigger', Repetition: { Interval: 'PT5M' } })).toEqual({
      descriptor: 'minutes 5',
      lossy: false
    })
  })

  it('flags unsupported triggers as lossy (never misrepresents)', () => {
    const r = cimTriggerToDescriptor({ CimClass: 'MSFT_TaskMonthlyTrigger', StartBoundary: '2026-01-01T03:00:00' })
    expect(r.lossy).toBe(true)
    expect(r.descriptor).toContain('MSFT_TaskMonthlyTrigger')
  })

  it('reads a one-shot time trigger back as a parseable once descriptor (no date loss)', () => {
    const r = cimTriggerToDescriptor({ CimClass: 'MSFT_TaskTimeTrigger', StartBoundary: '2026-07-01T08:00:00' })
    expect(r).toEqual({ descriptor: 'once 2026-07-01T08:00', lossy: false })
    expect(() => parseTriggerDescriptor(r.descriptor)).not.toThrow()
  })
})

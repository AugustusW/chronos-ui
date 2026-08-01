// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { nextRunAt } from '../../src/main/scheduler/next-run'

const NOW = new Date('2026-08-01T10:30:00') // local time, Saturday

describe('nextRunAt — native_cron (croner)', () => {
  it('*/5 * * * * → next 5-minute boundary', () => {
    expect(nextRunAt('native_cron', '*/5 * * * *', NOW)).toEqual(new Date('2026-08-01T10:35:00'))
  })
  it('0 18 * * * → today 18:00', () => {
    expect(nextRunAt('native_cron', '0 18 * * *', NOW)).toEqual(new Date('2026-08-01T18:00:00'))
  })
  it('0 9 * * 1 (Mondays) → next Monday 09:00', () => {
    expect(nextRunAt('native_cron', '0 9 * * 1', NOW)).toEqual(new Date('2026-08-03T09:00:00'))
  })
  it('15 8 1 * * (monthly DOM) → Sep 1 08:15', () => {
    expect(nextRunAt('native_cron', '15 8 1 * *', NOW)).toEqual(new Date('2026-09-01T08:15:00'))
  })
  it('invalid cron → null (never throws)', () => {
    expect(nextRunAt('native_cron', 'not a cron', NOW)).toBeNull()
  })
})

describe('nextRunAt — native_task (trigger mini-format)', () => {
  it('daily 18:30 → today 18:30', () => {
    expect(nextRunAt('native_task', 'daily 18:30', NOW)).toEqual(new Date('2026-08-01T18:30:00'))
  })
  it('daily 09:00 (already past) → tomorrow 09:00', () => {
    expect(nextRunAt('native_task', 'daily 09:00', NOW)).toEqual(new Date('2026-08-02T09:00:00'))
  })
  it('weekly MON,FRI 08:00 → next Monday 08:00', () => {
    expect(nextRunAt('native_task', 'weekly MON,FRI 08:00', NOW)).toEqual(new Date('2026-08-03T08:00:00'))
  })
  it('minutes 15 → now + 15 min', () => {
    expect(nextRunAt('native_task', 'minutes 15', NOW)).toEqual(new Date('2026-08-01T10:45:00'))
  })
  it('hourly 2 → now + 2 h', () => {
    expect(nextRunAt('native_task', 'hourly 2', NOW)).toEqual(new Date('2026-08-01T12:30:00'))
  })
  it('once 2026-08-05T07:00 (future) → that instant; past once → null', () => {
    expect(nextRunAt('native_task', 'once 2026-08-05T07:00', NOW)).toEqual(new Date('2026-08-05T07:00:00'))
    expect(nextRunAt('native_task', 'once 2026-07-01T07:00', NOW)).toBeNull()
  })
  it('onlogon / onstart / unparseable → null', () => {
    expect(nextRunAt('native_task', 'onlogon', NOW)).toBeNull()
    expect(nextRunAt('native_task', 'onstart', NOW)).toBeNull()
    expect(nextRunAt('native_task', 'garbage', NOW)).toBeNull()
  })
})

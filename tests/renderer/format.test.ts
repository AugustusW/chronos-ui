// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { cronToHuman, relativeTime, formatDuration, upcomingLabel } from '../../src/renderer/src/lib/format'

describe('cronToHuman', () => {
  it('humanizes common 5-field expressions, falls back to raw', () => {
    expect(cronToHuman('0 3 * * *')).toBe('Daily at 03:00')
    expect(cronToHuman('0 */6 * * *')).toBe('Every 6 hours')
    expect(cronToHuman('30 2 * * 1')).toBe('Mondays at 02:30')
    expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes')
    expect(cronToHuman('7 4 3 2 1')).toBe('7 4 3 2 1') // uncommon → raw passthrough
  })
})
describe('relativeTime', () => {
  it('formats relative to now', () => {
    const now = 1_000_000_000_000
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(relativeTime(now - 30_000, now)).toBe('just now')
  })
})
describe('formatDuration', () => {
  it('formats ms compactly', () => {
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(620_000)).toBe('10m 20s')
    expect(formatDuration(800)).toBe('0.8s')
  })
})
describe('upcomingLabel', () => {
  it('shows "in N min" when under 60 minutes away', () => {
    const now = new Date(2026, 7, 1, 10, 0, 0).getTime() // Sat Aug 1 2026, 10:00
    expect(upcomingLabel(now + 30 * 60_000, now)).toBe('in 30 min')
    expect(upcomingLabel(now + 1 * 60_000, now)).toBe('in 1 min')
    expect(upcomingLabel(now, now)).toBe('in 0 min')
  })
  it('shows HH:MM when 60+ minutes away but later the same calendar day', () => {
    const now = new Date(2026, 7, 1, 10, 0, 0).getTime()
    const later = new Date(2026, 7, 1, 14, 30, 0).getTime()
    expect(upcomingLabel(later, now)).toBe('14:30')
  })
  it('shows "tomorrow HH:MM" when the run crosses into the next calendar day', () => {
    const now = new Date(2026, 7, 1, 23, 0, 0).getTime()
    const next = new Date(2026, 7, 2, 1, 0, 0).getTime()
    expect(upcomingLabel(next, now)).toBe('tomorrow 01:00')
  })
  it('shows short-weekday + HH:MM when 2-6 calendar days out (e.g. next Monday)', () => {
    const now = new Date(2026, 7, 1, 10, 0, 0).getTime() // Sat Aug 1 2026, 10:00
    const nextMonday = new Date(2026, 7, 3, 9, 0, 0).getTime() // Mon Aug 3 2026, 09:00 (2 days out)
    expect(upcomingLabel(nextMonday, now)).toBe('Mon 09:00')
  })
  it('shows short-date + HH:MM when 7+ calendar days out (e.g. next month)', () => {
    const now = new Date(2026, 7, 1, 10, 0, 0).getTime() // Sat Aug 1 2026, 10:00
    const nextMonth = new Date(2026, 8, 1, 8, 15, 0).getTime() // Tue Sep 1 2026, 08:15
    expect(upcomingLabel(nextMonth, now)).toBe('Sep 1 08:15')
  })
})

// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { cronToHuman, relativeTime, formatDuration } from '../../src/renderer/src/lib/format'

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

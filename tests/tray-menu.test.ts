// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import {
  buildTrayMenuItems,
  buildTrayStatusText,
  buildTrayTitle,
  buildTrayTooltip
} from '../src/main/tray-menu'
import type { DashboardSummary } from '../src/main/services/dashboard.service'
import { TRAY_RECENT_FAILURES_LIMIT } from '../src/shared/dashboard-limits'

function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    runsToday: 0,
    succeededToday: 0,
    failedToday: 0,
    activeJobs: 0,
    failures: [],
    failuresTotal: 0,
    upcoming: [],
    generatedAt: Date.parse('2026-08-01T10:30:00'),
    ...over
  }
}

function failure(
  over: Partial<DashboardSummary['failures'][number]> = {}
): DashboardSummary['failures'][number] {
  return {
    jobId: 1,
    jobName: 'Backup',
    result: 'failure',
    exitCode: 1,
    durationMs: 500,
    startedAt: Date.parse('2026-08-01T09:15:00'),
    ...over
  }
}

describe('buildTrayMenuItems', () => {
  it('summary === null (still loading) falls back to just Open/Quit', () => {
    const items = buildTrayMenuItems(null, { onOpen: vi.fn(), onQuit: vi.fn(), onOpenJob: vi.fn() })
    expect(items.map((i) => i.label)).toEqual(['Open ChronosUI', 'Quit'])
  })

  it('zero failures / zero upcoming renders the same zero-state copy as DashboardView.vue', () => {
    const items = buildTrayMenuItems(summary(), {
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      onOpenJob: vi.fn()
    })
    const labels = items.map((i) => i.label)
    expect(labels).toContain('No failures today ✓')
    expect(labels).toContain('No upcoming runs')
    expect(labels).toContain('Today   ✓ 0   ✗ 0')
  })

  it('lists recent failures as clickable items wired to onOpenJob, capped at TRAY_RECENT_FAILURES_LIMIT', () => {
    const failures = Array.from({ length: TRAY_RECENT_FAILURES_LIMIT + 3 }, (_, i) =>
      failure({ jobId: i + 1, jobName: `Job${i + 1}` })
    )
    const onOpenJob = vi.fn()
    const items = buildTrayMenuItems(
      summary({ failures, failuresTotal: failures.length, failedToday: failures.length }),
      { onOpen: vi.fn(), onQuit: vi.fn(), onOpenJob }
    )
    const failureItems = items.filter((i) => i.label.startsWith('Job'))
    expect(failureItems).toHaveLength(TRAY_RECENT_FAILURES_LIMIT)
    failureItems[0].click?.()
    expect(onOpenJob).toHaveBeenCalledWith(1)
  })

  it('shows a "+N more…" item (wired to onOpen) when failuresTotal exceeds the shown slice', () => {
    const failures = Array.from({ length: TRAY_RECENT_FAILURES_LIMIT }, (_, i) =>
      failure({ jobId: i + 1 })
    )
    const onOpen = vi.fn()
    const items = buildTrayMenuItems(summary({ failures, failuresTotal: 12, failedToday: 12 }), {
      onOpen,
      onQuit: vi.fn(),
      onOpenJob: vi.fn()
    })
    const more = items.find((i) => i.label.includes('more'))
    expect(more?.label).toBe('+7 more…')
    more?.click?.()
    expect(onOpen).toHaveBeenCalled()
  })

  it('formats a recent failure as "name — HH:MM"', () => {
    const items = buildTrayMenuItems(
      summary({
        failures: [
          failure({ jobName: 'Nightly Backup', startedAt: Date.parse('2026-08-01T02:05:00') })
        ],
        failuresTotal: 1
      }),
      { onOpen: vi.fn(), onQuit: vi.fn(), onOpenJob: vi.fn() }
    )
    expect(items.some((i) => i.label === 'Nightly Backup — 02:05')).toBe(true)
  })

  it('shows the next upcoming job as a disabled (non-clickable) informational item', () => {
    const items = buildTrayMenuItems(
      summary({
        upcoming: [
          {
            jobId: 9,
            jobName: 'Sync',
            scheduleExpr: '0 * * * *',
            nextRunAt: Date.parse('2026-08-01T11:00:00')
          }
        ]
      }),
      { onOpen: vi.fn(), onQuit: vi.fn(), onOpenJob: vi.fn() }
    )
    const next = items.find((i) => i.label.startsWith('Next:'))
    expect(next).toEqual({ label: 'Next: Sync — 11:00', enabled: false })
  })

  it('always ends with Open ChronosUI + Quit, wired to the given callbacks', () => {
    const onOpen = vi.fn()
    const onQuit = vi.fn()
    const items = buildTrayMenuItems(summary(), { onOpen, onQuit, onOpenJob: vi.fn() })
    items.find((i) => i.label === 'Open ChronosUI')!.click?.()
    items.find((i) => i.label === 'Quit')!.click?.()
    expect(onOpen).toHaveBeenCalled()
    expect(onQuit).toHaveBeenCalled()
  })
})

describe('buildTrayStatusText / buildTrayTitle', () => {
  it('is empty (quiet) when summary is null', () => {
    expect(buildTrayStatusText(null)).toBe('')
    expect(buildTrayTitle(null)).toBe('')
  })

  it('is empty (quiet) when there are zero failures today, even with successes', () => {
    expect(buildTrayStatusText(summary({ succeededToday: 12, failedToday: 0 }))).toBe('')
  })

  it('renders "✓N ✗N" once there is at least one failure today', () => {
    expect(buildTrayStatusText(summary({ succeededToday: 12, failedToday: 2 }))).toBe('✓12 ✗2')
    expect(buildTrayTitle(summary({ succeededToday: 12, failedToday: 2 }))).toBe('✓12 ✗2')
  })
})

describe('buildTrayTooltip', () => {
  it('is the plain app name when quiet (no data / no failures)', () => {
    expect(buildTrayTooltip(null)).toBe('ChronosUI')
    expect(buildTrayTooltip(summary({ succeededToday: 5, failedToday: 0 }))).toBe('ChronosUI')
  })

  it('appends the compact status once there is a failure', () => {
    expect(buildTrayTooltip(summary({ succeededToday: 5, failedToday: 1 }))).toBe(
      'ChronosUI — ✓5 ✗1'
    )
  })
})

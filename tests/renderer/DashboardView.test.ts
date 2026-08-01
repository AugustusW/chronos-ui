// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetSingleton, useDashboardStore } from '../../src/renderer/src/stores/dashboard.store'

const dashboardSummary = vi.fn()
const pushSpy = vi.fn()

// Mock vue-router BEFORE importing DashboardView so the mock is in place. DashboardView imports
// RouterLink directly (for the Failures-card "Run History ›" link) — the mock must export a
// stand-in or that import resolves to undefined and Vue throws trying to render it.
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushSpy }),
  RouterLink: { props: ['to'], template: '<a class="router-link-stub"><slot /></a>' }
}))

const summary = (over: Record<string, unknown> = {}) => ({
  runsToday: 12,
  succeededToday: 10,
  failedToday: 0,
  activeJobs: 7,
  failures: [],
  failuresTotal: 0,
  upcoming: [],
  generatedAt: 0,
  ...over
})

beforeEach(() => {
  dashboardSummary.mockReset()
  dashboardSummary.mockResolvedValue(summary())
  // Extend (not replace) the jsdom window — replacing it wipes native constructors
  // (KeyboardEvent etc.) that @vue/test-utils' trigger() needs for keydown/click events.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window.chronos = { dashboardSummary }
  pushSpy.mockClear()
  _resetSingleton()
})

import DashboardView from '../../src/renderer/src/views/DashboardView.vue'
import SkeletonRows from '../../src/renderer/src/components/SkeletonRows.vue'
import StatusDot from '../../src/renderer/src/components/StatusDot.vue'

describe('DashboardView', () => {
  it('renders the four today tiles', async () => {
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.find('[data-test="tile-runs"]').text()).toContain('12')
    expect(w.find('[data-test="tile-succeeded"]').text()).toContain('10')
    expect(w.find('[data-test="tile-failed"]').text()).toContain('0')
    expect(w.find('[data-test="tile-active"]').text()).toContain('7')
  })

  it('marks the Failed tile as danger only when failedToday > 0', async () => {
    dashboardSummary.mockResolvedValue(summary({ failedToday: 0 }))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.find('[data-test="tile-failed"]').classes()).not.toContain('danger')

    dashboardSummary.mockResolvedValue(summary({ failedToday: 3 }))
    _resetSingleton()
    const w2 = mount(DashboardView)
    await flushPromises()
    expect(w2.find('[data-test="tile-failed"]').classes()).toContain('danger')
  })

  it('shows the empty-failures message when there are no failures', async () => {
    dashboardSummary.mockResolvedValue(summary({ failures: [] }))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.text()).toContain('No failures today ✓')
  })

  it('renders failure rows with StatusDot, exit-code badge, and a11y row semantics; keydown.enter navigates to job-detail', async () => {
    dashboardSummary.mockResolvedValue(summary({
      failedToday: 2,
      failures: [
        { jobId: 101, jobName: 'nightly-backup', result: 'failure', exitCode: 1, startedAt: new Date(2026, 7, 1, 9, 15, 0).getTime(), durationMs: 4200 },
        { jobId: 102, jobName: 'cleanup', result: 'timeout', exitCode: null, startedAt: new Date(2026, 7, 1, 8, 0, 0).getTime(), durationMs: 620_000 }
      ]
    }))
    const w = mount(DashboardView)
    await flushPromises()

    const rows = w.findAll('[data-test="failure-row"]')
    expect(rows.length).toBe(2)
    expect(rows[0].attributes('role')).toBe('button')
    expect(rows[0].attributes('tabindex')).toBe('0')
    expect(rows[0].findComponent(StatusDot).props('status')).toBe('fail')
    expect(rows[0].text()).toContain('exit 1')
    expect(rows[1].findComponent(StatusDot).props('status')).toBe('warn')
    expect(rows[1].text()).toContain('timeout')

    await rows[0].trigger('keydown.enter')
    expect(pushSpy).toHaveBeenCalledWith({ name: 'job-detail', params: { id: '101' } })
  })

  it('shows a "View all N in Run History" link only when failuresTotal > 20', async () => {
    dashboardSummary.mockResolvedValue(summary({ failuresTotal: 5, failures: [{ jobId: 1, jobName: 'a', result: 'failure', exitCode: 1, startedAt: 0, durationMs: 100 }] }))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.text()).not.toContain('View all')

    dashboardSummary.mockResolvedValue(summary({ failuresTotal: 27, failures: [{ jobId: 1, jobName: 'a', result: 'failure', exitCode: 1, startedAt: 0, durationMs: 100 }] }))
    _resetSingleton()
    const w2 = mount(DashboardView)
    await flushPromises()
    expect(w2.text()).toContain('View all 27 in Run History')
  })

  it('shows a failuresTotal count badge and a Run History link in the Failures card header', async () => {
    dashboardSummary.mockResolvedValue(summary({
      failedToday: 3,
      failures: [{ jobId: 1, jobName: 'a', result: 'failure', exitCode: 1, startedAt: 0, durationMs: 100 }],
      failuresTotal: 3
    }))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.find('[data-test="failures-badge"]').text()).toBe('3')
    const link = w.find('[data-test="history-link"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('Run History')
  })

  it('shows the empty-upcoming message when there are no upcoming runs', async () => {
    dashboardSummary.mockResolvedValue(summary({ upcoming: [] }))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.text()).toContain('No upcoming runs')
  })

  it('renders upcoming rows with a cronToHuman title', async () => {
    dashboardSummary.mockResolvedValue(summary({
      upcoming: [{ jobId: 5, jobName: 'weekly-report', scheduleExpr: '0 3 * * *', nextRunAt: Date.now() + 2 * 60 * 60_000 }]
    }))
    const w = mount(DashboardView)
    await flushPromises()
    const sched = w.find('[data-test="upcoming-sched"]')
    expect(sched.exists()).toBe(true)
    expect(sched.attributes('title')).toBe('Daily at 03:00')
    expect(sched.text()).toBe('0 3 * * *')
  })

  it('shows a skeleton while loading', async () => {
    let resolveSummary!: (v: ReturnType<typeof summary>) => void
    dashboardSummary.mockReturnValue(new Promise((res) => { resolveSummary = res }))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(true)

    resolveSummary(summary())
    await flushPromises()
    expect(w.findComponent(SkeletonRows).exists()).toBe(false)
  })

  it('shows an error message with a Retry button that calls refresh', async () => {
    dashboardSummary.mockRejectedValue(new Error('dashboard read failed'))
    const w = mount(DashboardView)
    await flushPromises()
    expect(w.text()).toContain('dashboard read failed')
    const retry = w.find('[data-test="retry"]')
    expect(retry.exists()).toBe(true)

    dashboardSummary.mockResolvedValue(summary({ runsToday: 99 }))
    await retry.trigger('click')
    await flushPromises()
    expect(w.find('[data-test="tile-runs"]').text()).toContain('99')
  })

  it('degrades a background-refresh error to an inline banner when a summary is already loaded (MUST FIX #2)', async () => {
    dashboardSummary.mockResolvedValueOnce(summary({ runsToday: 12 }))
    const w = mount(DashboardView)
    await flushPromises()
    // Sanity: no banner yet — the full-page error state never shows once a summary has loaded.
    expect(w.find('[data-test="error-banner"]').exists()).toBe(false)

    // Simulate a background refresh failing (e.g. RunEvent-triggered) the same way applyRunEvent
    // would, by calling the view's own store singleton directly.
    dashboardSummary.mockRejectedValueOnce(new Error('refresh failed'))
    await useDashboardStore().refresh()
    await flushPromises()

    // Tiles (and the previously loaded summary) remain visible — no full-page error takeover.
    expect(w.find('[data-test="tile-runs"]').text()).toContain('12')
    const banner = w.find('[data-test="error-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('refresh failed')
    expect(banner.find('[data-test="retry"]').exists()).toBe(true)
  })
})

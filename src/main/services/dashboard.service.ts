// SPDX-License-Identifier: Apache-2.0
import type { Repositories, FailureRow } from '../db/repositories'
import { nextRunAt } from '../scheduler/next-run'
import { DASHBOARD_FAILURES_LIMIT, DASHBOARD_UPCOMING_LIMIT } from '../../shared/dashboard-limits'

// Re-exported for backward compatibility (existing importers, e.g. dashboard.service.test.ts) —
// src/shared/dashboard-limits.ts is now the source of truth so the renderer can import the same
// constants without pulling this (main-process-only) module into its bundle.
export { DASHBOARD_FAILURES_LIMIT, DASHBOARD_UPCOMING_LIMIT }

/** Start of `now`'s local calendar day — the "today" window boundary for the dashboard's
 *  runsToday/succeededToday/failedToday/failures aggregates (spec §2). */
export function localMidnight(now: Date): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}

export interface UpcomingRow {
  jobId: number
  jobName: string
  scheduleExpr: string
  nextRunAt: number
}

export interface DashboardSummary {
  runsToday: number
  succeededToday: number
  failedToday: number
  activeJobs: number
  failures: Array<Omit<FailureRow, 'startedAt'> & { startedAt: number }>
  failuresTotal: number
  upcoming: UpcomingRow[]
  generatedAt: number
}

/** Assembles the dashboard summary from Repositories.dashboard (today-window aggregates) plus a
 *  croner-computed "upcoming" projection over enabled+adopted jobs. Dates are serialized to
 *  epoch ms (same convention as ReconcileResult.generatedAt) so the shape crosses IPC untouched. */
export function createDashboardService(deps: { repos: Repositories; now?: () => Date }): {
  getSummary(): Promise<DashboardSummary>
} {
  const nowFn = deps.now ?? (() => new Date())
  return {
    async getSummary(): Promise<DashboardSummary> {
      const now = nowFn()
      const since = localMidnight(now)
      const [counts, failures, failuresTotal, activeJobs, enabledJobs] = await Promise.all([
        deps.repos.dashboard.countsSince(since),
        deps.repos.dashboard.listFailuresSince(since, DASHBOARD_FAILURES_LIMIT),
        deps.repos.dashboard.countFailuresSince(since),
        deps.repos.dashboard.countActiveJobs(),
        deps.repos.jobs.list({ enabled: true })
      ])
      const upcoming = enabledJobs
        .filter((j) => j.adopted)
        .map((j) => ({ j, at: nextRunAt(j.source, j.scheduleExpr, now) }))
        .filter((x): x is { j: (typeof enabledJobs)[number]; at: Date } => x.at !== null)
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(0, DASHBOARD_UPCOMING_LIMIT)
        .map(({ j, at }) => ({ jobId: j.id, jobName: j.name, scheduleExpr: j.scheduleExpr, nextRunAt: at.getTime() }))
      return {
        runsToday: counts.runs,
        succeededToday: counts.succeeded,
        failedToday: counts.failed,
        activeJobs,
        failures: failures.map((f: FailureRow) => ({ ...f, startedAt: f.startedAt.getTime() })),
        failuresTotal,
        upcoming,
        generatedAt: now.getTime()
      }
    }
  }
}

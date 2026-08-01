// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import {
  createDashboardService,
  localMidnight,
  DASHBOARD_FAILURES_LIMIT,
  DASHBOARD_UPCOMING_LIMIT
} from '../../src/main/services/dashboard.service'
import type { Repositories, FailureRow } from '../../src/main/db/repositories'
import type { Job } from '../../src/main/db/schema'
import { nextRunAt } from '../../src/main/scheduler/next-run'

function job(over: Partial<Job> = {}): Job {
  return {
    id: 1,
    name: 'Job',
    source: 'native_cron',
    platform: 'darwin',
    scheduleExpr: '*/5 * * * *',
    command: 'echo hi',
    workingDir: null,
    env: null,
    enabled: true,
    adopted: true,
    timeoutSec: null,
    category: null,
    notifyOnFailure: false,
    lastRunAt: null,
    lastResult: null,
    createdAt: new Date('2026-01-01T00:00:00'),
    updatedAt: new Date('2026-01-01T00:00:00'),
    ...over
  }
}

function fakeRepos(opts: {
  counts?: { runs: number; succeeded: number; failed: number }
  failures?: FailureRow[]
  failuresTotal?: number
  activeJobs?: number
  jobs?: Job[]
} = {}): Repositories {
  const counts = opts.counts ?? { runs: 0, succeeded: 0, failed: 0 }
  const failures = opts.failures ?? []
  const failuresTotal = opts.failuresTotal ?? 0
  const activeJobs = opts.activeJobs ?? 0
  const jobsList = opts.jobs ?? []
  return {
    jobs: {
      list: vi.fn(async () => jobsList)
    },
    dashboard: {
      countsSince: vi.fn(async () => counts),
      listFailuresSince: vi.fn(async () => failures),
      countFailuresSince: vi.fn(async () => failuresTotal),
      countActiveJobs: vi.fn(async () => activeJobs)
    }
  } as unknown as Repositories
}

describe('localMidnight', () => {
  it('truncates a Date to local midnight of the same day', () => {
    const now = new Date('2026-08-01T10:30:00')
    expect(localMidnight(now)).toEqual(new Date('2026-08-01T00:00:00'))
  })
})

describe('dashboard.service getSummary — counts/failures pass-through', () => {
  it('passes counts/failuresTotal/activeJobs through and converts failures.startedAt to epoch ms', async () => {
    const startedAt = new Date('2026-08-01T09:00:00')
    const failureRow: FailureRow = {
      jobId: 7,
      jobName: 'Backup',
      result: 'failure',
      exitCode: 1,
      startedAt,
      durationMs: 500
    }
    const repos = fakeRepos({
      counts: { runs: 10, succeeded: 8, failed: 2 },
      failures: [failureRow],
      failuresTotal: 2,
      activeJobs: 3,
      jobs: []
    })
    const now = new Date('2026-08-01T10:30:00')
    const svc = createDashboardService({ repos, now: () => now })

    const summary = await svc.getSummary()

    expect(summary.runsToday).toBe(10)
    expect(summary.succeededToday).toBe(8)
    expect(summary.failedToday).toBe(2)
    expect(summary.activeJobs).toBe(3)
    expect(summary.failuresTotal).toBe(2)
    expect(summary.failures).toEqual([
      { jobId: 7, jobName: 'Backup', result: 'failure', exitCode: 1, durationMs: 500, startedAt: startedAt.getTime() }
    ])
    expect(summary.generatedAt).toBe(now.getTime())
    expect(repos.dashboard.countsSince).toHaveBeenCalledWith(localMidnight(now))
    expect(repos.dashboard.listFailuresSince).toHaveBeenCalledWith(localMidnight(now), DASHBOARD_FAILURES_LIMIT)
    expect(repos.dashboard.countFailuresSince).toHaveBeenCalledWith(localMidnight(now))
  })
})

describe('dashboard.service getSummary — upcoming', () => {
  it('skips unparseable schedules and sorts the rest ascending by nextRunAt', async () => {
    const now = new Date('2026-08-01T10:00:00')
    const jobs: Job[] = [
      job({ id: 2, name: 'DailyTask', source: 'native_task', scheduleExpr: 'daily 11:00' }),
      job({ id: 1, name: 'Every5', source: 'native_cron', scheduleExpr: '*/5 * * * *' }),
      job({ id: 3, name: 'Broken', source: 'native_cron', scheduleExpr: 'not-a-cron' })
    ]
    const repos = fakeRepos({ jobs })
    const svc = createDashboardService({ repos, now: () => now })

    const summary = await svc.getSummary()

    // job 3 (broken cron) never parses → excluded. job 1 fires within 5 min, well before
    // job 2's 11:00 daily trigger, so ascending order is [1, 2] regardless of list order.
    expect(summary.upcoming.map((u) => u.jobId)).toEqual([1, 2])
    expect(summary.upcoming[0].nextRunAt).toBeLessThan(summary.upcoming[1].nextRunAt)
    expect(summary.upcoming[0]).toEqual({
      jobId: 1, jobName: 'Every5', scheduleExpr: '*/5 * * * *', nextRunAt: summary.upcoming[0].nextRunAt
    })
  })

  it('caps upcoming at DASHBOARD_UPCOMING_LIMIT, keeping the earliest N by nextRunAt (final review #5/T4 identity check)', async () => {
    const now = new Date('2026-08-01T10:00:00')
    const total = DASHBOARD_UPCOMING_LIMIT + 5
    const jobs: Job[] = Array.from({ length: total }, (_, i) =>
      job({ id: i + 1, name: `Job${i + 1}`, source: 'native_cron', scheduleExpr: `${i % 60} * * * *` })
    )
    const repos = fakeRepos({ jobs })
    const svc = createDashboardService({ repos, now: () => now })

    const summary = await svc.getSummary()

    expect(summary.upcoming).toHaveLength(DASHBOARD_UPCOMING_LIMIT)

    // The kept slice must be non-decreasing by nextRunAt (ascending-sort contract).
    const keptTimes = summary.upcoming.map((u) => u.nextRunAt)
    for (let i = 1; i < keptTimes.length; i++) expect(keptTimes[i]).toBeGreaterThanOrEqual(keptTimes[i - 1])

    // Identity: independently recompute every job's next-run via the same nextRunAt() the service
    // uses, then verify the kept set is genuinely the *earliest* DASHBOARD_UPCOMING_LIMIT jobs —
    // i.e. every excluded job's nextRunAt is >= every kept job's nextRunAt. This catches an
    // off-by-slice / wrong-sort-direction bug that a length-only assertion would miss.
    const keptIds = new Set(summary.upcoming.map((u) => u.jobId))
    const allTimes = jobs.map((j) => ({ jobId: j.id, at: nextRunAt(j.source, j.scheduleExpr, now)!.getTime() }))
    const keptComputed = allTimes.filter((x) => keptIds.has(x.jobId)).map((x) => x.at)
    const excludedComputed = allTimes.filter((x) => !keptIds.has(x.jobId)).map((x) => x.at)
    expect(keptComputed).toHaveLength(DASHBOARD_UPCOMING_LIMIT)
    expect(excludedComputed).toHaveLength(total - DASHBOARD_UPCOMING_LIMIT)
    expect(Math.max(...keptComputed)).toBeLessThanOrEqual(Math.min(...excludedComputed))
  })

  it('requests enabled jobs from the repo and further filters to adopted ones', async () => {
    const now = new Date('2026-08-01T10:00:00')
    const jobs: Job[] = [
      job({ id: 1, name: 'AdoptedEnabled', adopted: true, enabled: true, scheduleExpr: '*/5 * * * *' }),
      job({ id: 2, name: 'UnadoptedEnabled', adopted: false, enabled: true, scheduleExpr: '*/5 * * * *' })
    ]
    const repos = fakeRepos({ jobs })
    const svc = createDashboardService({ repos, now: () => now })

    const summary = await svc.getSummary()

    expect(repos.jobs.list).toHaveBeenCalledWith({ enabled: true })
    expect(summary.upcoming.map((u) => u.jobId)).toEqual([1]) // unadopted job filtered out client-side
  })
})

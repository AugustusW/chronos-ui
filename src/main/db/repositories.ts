// SPDX-License-Identifier: Apache-2.0
import type { DatabaseHandle, SqliteDb, PgDb } from './client'
import type { Job, NewJob, RunLog } from './schema'
import * as sq from './jobs.repository'
import * as sr from './runLogs.repository'
import * as sd from './dashboard.repository'
import { createPgJobsRepo } from './jobs.repository.pg'
import { createPgRunLogsRepo } from './runLogs.repository.pg'
import { createPgDashboardRepo } from './dashboard.repository.pg'
import { createSqliteNotifySettingsRepo, type NotifySettingsRepo } from './notifySettings.repository'
import { createPgNotifySettingsRepo } from './notifySettings.repository.pg'

// FailureRow is defined in dashboard.repository.ts (not here) to avoid a repositories.ts ↔
// dashboard.repository.ts circular import; re-exported so consumers only need this module.
import type { FailureRow } from './dashboard.repository'
export type { FailureRow }

type RunResult = 'success' | 'failure' | 'timeout'
type TriggeredBy = 'schedule' | 'manual'
type FinishRunInput = {
  result: RunResult
  endedAt?: Date
  exitCode?: number
  stdout?: string
  stderr?: string
}

export interface JobsRepo {
  create(input: NewJob): Promise<Job>
  get(id: number): Promise<Job | undefined>
  list(filter?: { enabled?: boolean; category?: string }): Promise<Job[]>
  update(id: number, patch: Partial<NewJob>): Promise<Job | undefined>
  remove(id: number): Promise<void>
  setCachedRun(id: number, data: { lastRunAt: Date; lastResult: RunResult }): Promise<void>
}

export interface RunLogsRepo {
  startRun(input: { jobId: number; triggeredBy: TriggeredBy; startedAt?: Date }): Promise<RunLog>
  finishRun(id: number, input: FinishRunInput): Promise<RunLog | undefined>
  listRecent(limit?: number): Promise<RunLog[]>
  listForJob(jobId: number, limit?: number): Promise<RunLog[]>
  getLatest(jobId: number): Promise<RunLog | undefined>
  /** Delete runs older than `cutoff` (retention sweep); returns rows removed. */
  pruneOlderThan(cutoff: Date): Promise<number>
}

export interface DashboardRepo {
  countsSince(since: Date): Promise<{ runs: number; succeeded: number; failed: number }>
  listFailuresSince(since: Date, limit: number): Promise<FailureRow[]>
  countFailuresSince(since: Date): Promise<number>
  countActiveJobs(): Promise<number> // enabled AND adopted
}

export interface Repositories {
  jobs: JobsRepo
  runLogs: RunLogsRepo
  notifySettings: NotifySettingsRepo
  dashboard: DashboardRepo
}

/** SQLite repositories: thin async wrappers over the existing synchronous free functions. */
function sqliteRepos(db: SqliteDb): Repositories {
  return {
    jobs: {
      create: async (input) => sq.createJob(db, input),
      get: async (id) => sq.getJob(db, id),
      list: async (filter) => sq.listJobs(db, filter),
      update: async (id, patch) => sq.updateJob(db, id, patch),
      remove: async (id) => {
        sq.deleteJob(db, id)
      },
      setCachedRun: async (id, data) => {
        sq.setJobCachedRun(db, id, data)
      }
    },
    runLogs: {
      startRun: async (input) => sr.startRun(db, input),
      finishRun: async (id, input) => sr.finishRun(db, id, input),
      listRecent: async (limit) => sr.listRecentRuns(db, limit),
      listForJob: async (jobId, limit) => sr.listRunsForJob(db, jobId, limit),
      getLatest: async (jobId) => sr.getLatestRun(db, jobId),
      pruneOlderThan: async (cutoff) => sr.pruneRunsOlderThan(db, cutoff)
    },
    notifySettings: createSqliteNotifySettingsRepo(db),
    dashboard: {
      countsSince: async (since) => sd.countsSince(db, since),
      listFailuresSince: async (since, limit) => sd.listFailuresSince(db, since, limit),
      countFailuresSince: async (since) => sd.countFailuresSince(db, since),
      countActiveJobs: async () => sd.countActiveJobs(db)
    }
  }
}

/** Build the dialect-appropriate repositories from an open database handle. */
export function createRepositories(handle: DatabaseHandle): Repositories {
  if (handle.dialect === 'postgres') {
    const db = handle.db as PgDb
    return {
      jobs: createPgJobsRepo(db),
      runLogs: createPgRunLogsRepo(db),
      notifySettings: createPgNotifySettingsRepo(db),
      dashboard: createPgDashboardRepo(db)
    }
  }
  return sqliteRepos(handle.db as SqliteDb)
}

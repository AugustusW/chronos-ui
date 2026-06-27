// SPDX-License-Identifier: Apache-2.0
import type { DatabaseHandle, SqliteDb, PgDb } from './client'
import type { Job, NewJob, RunLog } from './schema'
import * as sq from './jobs.repository'
import * as sr from './runLogs.repository'
import { createPgJobsRepo } from './jobs.repository.pg'
import { createPgRunLogsRepo } from './runLogs.repository.pg'

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
}

export interface Repositories {
  jobs: JobsRepo
  runLogs: RunLogsRepo
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
      getLatest: async (jobId) => sr.getLatestRun(db, jobId)
    }
  }
}

/** Build the dialect-appropriate repositories from an open database handle. */
export function createRepositories(handle: DatabaseHandle): Repositories {
  if (handle.dialect === 'postgres') {
    const db = handle.db as PgDb
    return { jobs: createPgJobsRepo(db), runLogs: createPgRunLogsRepo(db) }
  }
  return sqliteRepos(handle.db as SqliteDb)
}

// SPDX-License-Identifier: Apache-2.0
import type { Job, RunLog } from '../main/db/schema'
import type { ParsedJob, BatchWriteResult, WriteResult } from '../main/scheduler/types'

export const IPC = {
  appGetVersion: 'app:getVersion',
  jobsList: 'jobs:list',
  jobsReconcile: 'jobs:reconcile',
  jobsCreate: 'jobs:create',
  jobsUpdate: 'jobs:update',
  jobsEnable: 'jobs:enable',
  jobsDisable: 'jobs:disable',
  jobsDelete: 'jobs:delete',
  jobsAdopt: 'jobs:adopt',
  jobsUnadopt: 'jobs:unadopt',
  jobsRunNow: 'jobs:runNow',
  runsListForJob: 'runs:listForJob',
  runsRecent: 'runs:recent',
  jobsRunNowStreaming: 'jobs:runNowStreaming',
  jobsRunBatchCancel: 'jobs:runBatchCancel',
  runEvent: 'run:event',
  notifyGet: 'notify:get',
  notifySave: 'notify:save',
  notifyTest: 'notify:test'
} as const

export interface AppVersion {
  name: string
  version: string
}

/** Reconcile classification of one row (spec §4.4, design §5). */
export type ReconcileStatus = 'in_sync' | 'drifted' | 'unmanaged' | 'orphan_native' | 'vanished'

export interface JobListItem {
  status: ReconcileStatus
  job?: Job // present for in_sync / drifted / vanished
  native?: ParsedJob // present for in_sync / drifted / unmanaged / orphan_native
  driftFields?: Array<'scheduleExpr' | 'command' | 'enabled'> // present for drifted
}

export interface ReconcileResult {
  items: JobListItem[]
  generatedAt: number
}

/** Renderer → main. Service derives source/platform/enabled/adopted. */
export interface CreateJobInput {
  name: string
  scheduleExpr: string
  command: string
  workingDir?: string
  env?: Record<string, string>
  timeoutSec?: number
  category?: string
  notifyOnFailure?: boolean
}

export interface UpdateJobChanges {
  name?: string
  scheduleExpr?: string
  command?: string
  workingDir?: string
  env?: Record<string, string>
  timeoutSec?: number
  category?: string
  notifyOnFailure?: boolean
}

/** Renderer → main adopt item — an unmanaged native line the user chose to take over (has no DB id yet). */
export interface AdoptItem {
  name?: string
  scheduleExpr: string
  command: string
}

/** Manual-run outcome (architect MEDIUM #5 — discriminated union instead of a faked RunLog). */
export type RunNowResult =
  | { status: 'completed'; run: RunLog }
  | { status: 'ui_timeout'; jobId: number; waitedMs: number }

/** Live-run event pushed main → renderer over IPC.runEvent. */
export type RunEvent =
  | { kind: 'started'; jobId: number; runId: number; triggeredBy: 'manual'; startedAt: number }
  | { kind: 'output'; runId: number; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'finished'; runId: number; result: 'success' | 'failure'; exitCode: number | null; endedAt: number }
  | { kind: 'jobsChanged' }

export type { Job, RunLog, ParsedJob, BatchWriteResult, WriteResult }
export type { NotifySettingsDTO, NotifySaveInput, SaveResult } from '../main/services/notify.service'

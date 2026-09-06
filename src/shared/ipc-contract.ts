// SPDX-License-Identifier: Apache-2.0
import type { Job, RunLog, JobRevision } from '../main/db/schema'
export type { JobRevision }
import type { ParsedJob, BatchWriteResult, WriteResult } from '../main/scheduler/types'
import type { TeardownResult } from '../main/services/jobs.service'
import type { PgDsnParts } from '../main/services/pg-dsn'
import type { TestConnectionResult } from '../main/services/backend-switch'

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
  jobsForget: 'jobs:forget',
  jobsRunNow: 'jobs:runNow',
  runsListForJob: 'runs:listForJob',
  runsRecent: 'runs:recent',
  jobsRunNowStreaming: 'jobs:runNowStreaming',
  jobsRunBatchCancel: 'jobs:runBatchCancel',
  runEvent: 'run:event',
  notifyGet: 'notify:get',
  notifySave: 'notify:save',
  notifyTest: 'notify:test',
  jobsManagedCount: 'jobs:managedCount',
  appTeardown: 'app:teardown',
  pgTestConnection: 'pg:testConnection',
  pgSaveSwitch: 'pg:saveSwitch',
  pgGetStatus: 'pg:getStatus',
  // dashboard:summary intentionally aggregates the whole page's read model in one invoke (single
  // fetch per view). Do NOT treat this as precedent for stuffing unrelated concerns into one
  // channel; a future trend-chart endpoint gets its own channel (architect LOW-2).
  dashboardSummary: 'dashboard:summary',
  // v0.4.0: the trend-chart endpoint LOW-2 above was written for — its own channel, per-job.
  jobsRunDurationTrend: 'jobs:runDurationTrend',
  runsSearch: 'runs:search',
  jobsExportYaml: 'jobs:exportYaml',
  jobsImportPreview: 'jobs:importPreview',
  jobsImportApply: 'jobs:importApply',
  // A job's configuration change log. Read-only — reverting is an ordinary jobs:update
  // with the old values, so it goes through the same validation and the same adapter guards.
  jobsRevisions: 'jobs:revisions',
  // Push the DB's schedule + command back into the native scheduler. Separate from jobs:update
  // because update() only forwards a field that differs from the DB row, and restoring an external
  // change means re-sending values the DB already holds.
  jobsRestoreToScheduler: 'jobs:restoreToScheduler'
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
  /** What the user wants this job called in ChronosUI. Editable in the dialog. NOT the scheduler's
   *  own name for the task — see `native`, which the user never edits. The two share a word and
   *  mean different things, which is the easiest wire in this flow to cross. */
  name?: string
  scheduleExpr: string
  command: string
  category?: string
  /** The scheduler's identity for the task being adopted. Windows needs it because the task keeps
   *  its own name and folder; crontab finds its line by schedule and command and sends none. */
  native?: { name: string; path: string }
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

/** Renderer → main pg-settings-UI save/switch payload (Bolt 3, T13). `fields` carries the connection
 *  form's current values regardless of `targetBackend` — the handler only validates/uses them when
 *  targetBackend='postgres' (a switch back to sqlite needs no connection details). */
export interface PgSaveSwitchInput {
  fields: PgDsnParts
  copyData: boolean
  targetBackend: 'postgres' | 'sqlite'
}

export type PgSaveSwitchResult = { ok: true } | { ok: false; error: string }

/** Renderer → main pg-settings-UI status read (Bolt 4, T15) — the currently active backend + whether
 *  this platform has a writable OS keychain (drives the settings UI's fallback-storage warning, same
 *  signal notify.service.ts's tokenStorage already surfaces for the Telegram token). */
export interface PgStatus {
  activeBackend: 'sqlite' | 'postgres'
  keychainAvailable: boolean
}

/** Renderer → main Run History search filters (v0.4.0, RunHistoryView.vue's runs:search channel).
 *  `since` is epoch ms — the renderer resolves a date-range PRESET ('today'/'7d'/'30d'/'all') down
 *  to this single bound (or omits it for 'all') before it ever crosses IPC; the main process only
 *  ever sees a plain timestamp, never preset semantics. */
export interface RunSearchInput {
  jobId?: number
  result?: 'success' | 'failure' | 'timeout'
  since?: number
  searchText?: string
  limit?: number
}

/** One point of a job's run-duration trend (v0.4.0 JobDetailView sparkline, jobs:runDurationTrend). */
export interface RunDurationTrendPoint {
  durationMs: number | null
  result: 'success' | 'failure' | 'timeout'
  startedAt: number
}

/** YAML import/export job schema (v0.4.0) — deliberately the SAME shape as CreateJobInput plus
 *  `enabled` (a real config toggle worth round-tripping, unlike `adopted`/DB id/run history, which
 *  are excluded — see README.md's "YAML job schema" section for the full rationale). Both export
 *  and import use this one type so the file format only has to be documented once. */
export interface YamlJobEntry {
  name: string
  scheduleExpr: string
  command: string
  workingDir?: string
  env?: Record<string, string>
  timeoutSec?: number
  category?: string
  notifyOnFailure?: boolean
  enabled?: boolean
}

export type JobDiffKind = 'new' | 'changed' | 'unchanged'

/** One row of an import preview — `entry` is what the YAML file says, `existingId`/`changedFields`
 *  are only present for 'changed' (which existing job it'll update, and which fields differ). */
export interface JobDiffEntry {
  kind: JobDiffKind
  entry: YamlJobEntry
  existingId?: number
  changedFields?: string[]
}

export interface ImportPreview {
  fileName: string
  entries: JobDiffEntry[]
}

/** Every file-dialog-backed IPC result carries a `status` so the renderer can tell "the user
 *  cancelled the dialog" (not an error — no toast/banner) apart from "something actually failed"
 *  (show the error) apart from success. */
export type ExportYamlResult = { status: 'ok'; path: string } | { status: 'canceled' } | { status: 'error'; error: string }
export type ImportPreviewResult = { status: 'ok'; preview: ImportPreview } | { status: 'canceled' } | { status: 'error'; error: string }
export type ImportApplyResult = { ok: boolean; created: number; updated: number; errors: string[] }

export type { Job, RunLog, ParsedJob, BatchWriteResult, WriteResult, TeardownResult }
export type { NotifySettingsDTO, NotifySaveInput, SaveResult } from '../main/services/notify.service'
export type { PgDsnParts, TestConnectionResult }
export type { DashboardSummary, UpcomingRow } from '../main/services/dashboard.service'
export type { RunLogWithJob } from '../main/db/repositories'

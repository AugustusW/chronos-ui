// SPDX-License-Identifier: Apache-2.0

/** Injected command runner — real impls shell out (crontab / powershell); tests pass a fake. */
export type ExecFn = (
  cmd: string,
  args: string[],
  stdin?: string
) => Promise<{ stdout: string; exitCode: number }>

/** A job as seen in the native scheduler (returned by list()). */
export interface ParsedJob {
  chronosId: number | null // null = unmanaged (pre-existing) line/task shown read-only until adopted
  scheduleExpr: string
  scheduleExprFormat: 'cron' | 'win-trigger' // architect D3: which language scheduleExpr is in
  command: string // ORIGINAL command (for adopted, unwrapped from the schedmgr action/line)
  adopted: boolean
  enabled: boolean
  canAdopt?: boolean // architect D4: Windows — false for ≠1-action / non-exec / elevated external tasks; undefined ⇒ adoptable (crontab)
  scheduleLossy?: boolean // architect D3: scheduleExpr is a best-effort read-back of an unsupported trigger (display-only)
  name?: string // #8: native name where the scheduler has one (Windows Task Scheduler TaskName). crontab has none → undefined.
}

export interface DriftResult {
  drifted: boolean
  currentHash: string
  expectedHash: string
}

/** Discriminant for renderer error handling (architect LOW #6). `error` stays human-readable detail. */
export type KnownErrorCode =
  | 'not_found'
  | 'no_match'
  | 'already_exists'
  | 'adopted_command_change'
  | 'spawn_failed'
  | 'invalid_input'
  | 'db_error'

/** Every mutating op returns this. `drift` means the hash-guard refused (recover via detectDrift). */
export interface WriteResult {
  ok: boolean
  reason?: 'drift' | 'error'
  drift?: DriftResult
  error?: string
  errorCode?: KnownErrorCode
}

export interface AdoptionSpec {
  chronosId: number
  scheduleExpr: string
  command: string // the original command to wrap
}

/** Result of adoptMany. `adopted` = chronosIds the adapter actually wrapped (crontab: all-or-nothing; Windows: the prefix that succeeded). */
export interface BatchWriteResult {
  ok: boolean
  reason?: 'drift' | 'error'
  drift?: DriftResult
  error?: string
  errorCode?: KnownErrorCode
  adopted: number[]
}

/** teardown 用：把一個 job 從 ChronosUI 的管理中釋放。adopted 會還原原指令，created 只拆標記。 */
export interface ReleaseSpec {
  chronosId: number
  originalCommand: string // 來自 DB 的原始指令；created job 用不到，但一併帶著讓 adapter 不必回查
}

/**
 * releaseAll 的結果。`skipped` = 原生排程器裡已經找不到的（外部刪除/drift），**不算失敗**：
 * teardown 是使用者的離開路徑，不可被一筆無關的外部改動卡住（adoptMany 的 no_match abort 語意
 * 刻意不同，因為 adopt 是可重試的選配動作）。
 */
export interface ReleaseResult {
  ok: boolean
  reason?: 'drift' | 'error'
  drift?: DriftResult
  error?: string
  errorCode?: KnownErrorCode
  released: number[]
  skipped: { chronosId: number; reason: 'no_match' }[]
}

export interface AdoptOptions {
  scheduleExpr: string
  command: string // the original command to wrap
  schedmgrPath: string // absolute path to the schedmgr binary (Plan 7 resolves; injected here)
  dbPath: string // absolute path to the chronos SQLite db (Plan 5 resolves; injected here)
}

/**
 * Cross-platform scheduler interface. CrontabAdapter (this plan) and the future Windows
 * TaskSchedulerAdapter (Plan 4b) both implement it. Method names are operation-semantic (no
 * crontab whole-table-rewrite leakage). NOTE (architect M1): persisting the resulting jobs-table
 * changes (e.g. `adopted`/`enabled` via updateJob, never setJobCachedRun) is the caller's job
 * (Plan 5 IPC layer); the adapter only edits the native scheduler.
 */
export interface SchedulerAdapter {
  list(): Promise<ParsedJob[]>
  createJob(input: { chronosId: number; scheduleExpr: string; command: string }): Promise<WriteResult>
  updateJob(chronosId: number, changes: { scheduleExpr?: string; command?: string }): Promise<WriteResult>
  enableJob(chronosId: number): Promise<WriteResult>
  disableJob(chronosId: number): Promise<WriteResult>
  deleteJob(chronosId: number): Promise<WriteResult>
  adopt(chronosId: number, opts: AdoptOptions): Promise<WriteResult>
  /** Adopt several unmanaged lines in one write (crontab: single read-modify-write; Windows: per-task). */
  adoptMany(specs: AdoptionSpec[]): Promise<BatchWriteResult>
  unadopt(chronosId: number, originalCommand: string): Promise<WriteResult>
  /** Release every listed job from ChronosUI management (teardown). crontab: one read-modify-write;
   *  Windows: per-task. Jobs missing from the native scheduler go to `skipped`, not an abort. */
  releaseAll(specs: ReleaseSpec[]): Promise<ReleaseResult>
  detectDrift(): Promise<DriftResult>
  /** Install (or replace) the managed flush cron entry that runs `schedmgr notify-flush` every windowMin minutes. */
  installFlushEntry(windowMin: number): Promise<WriteResult>
  /** Remove the managed flush cron entry (and its reserved marker comment). No-op if absent. */
  removeFlushEntry(): Promise<WriteResult>
}

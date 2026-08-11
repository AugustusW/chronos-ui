// SPDX-License-Identifier: Apache-2.0
import { ipcMain } from 'electron'
import { IPC, type AppVersion } from '../shared/ipc-contract'
import { isNotifyTokenFormat, isChatIdFormat } from '../shared/notify-validation'
import type {
  CreateJobInput, UpdateJobChanges, AdoptItem, ReconcileResult, RunNowResult, PgDsnParts, PgSaveSwitchInput, PgSaveSwitchResult, PgStatus, DashboardSummary,
  RunSearchInput, RunLogWithJob, RunDurationTrendPoint, YamlJobEntry, ExportYamlResult, ImportPreviewResult, ImportApplyResult
} from '../shared/ipc-contract'
import type { JobsService } from './services/jobs.service'
import type { NotifyService, NotifySaveInput } from './services/notify.service'
import type { JobIoService } from './services/job-io.service'
import type { RunLog } from './db/schema'
import type { RunSearchFilters } from './db/repositories'
import type { WriteResult, BatchWriteResult } from './scheduler/types'
import { buildDsn } from './services/pg-dsn'
import type { TestConnectionResult, SwitchResult } from './services/backend-switch'
import { RUN_SEARCH_PAGE_SIZE } from '../shared/dashboard-limits'

export const MAX_BATCH_ADOPT = 100

export interface IpcDeps {
  meta: { name: string; version: string }
  service: JobsService
  notify: NotifyService
  runNow: (id: number) => Promise<RunNowResult>
  listRunsForJob: (jobId: number, limit?: number) => Promise<RunLog[]>
  recentRuns: (limit?: number) => Promise<RunLog[]>
  runNowStreaming: (id: number) => Promise<void>
  cancelBatch: () => void
  // T13: pg settings UI — wired by bootstrap.ts to the real backend-switch.ts functions.
  pgTestConnection: (dsn: string) => Promise<TestConnectionResult>
  pgSwitchToPostgres: (config: { dsn: string; copy: boolean }) => Promise<SwitchResult>
  pgSwitchToSqlite: () => Promise<SwitchResult>
  // T15: pg settings UI status read — the active backend + whether this platform has a writable
  // keychain, so the settings UI can render its badge + fallback-storage warning without the
  // renderer itself knowing anything about backendConfig.json or keychain plumbing.
  pgGetStatus: () => Promise<PgStatus>
  /** Drains a live postgres pool (db/lifecycle.ts's drainPgHandle), no-op for a sqlite handle —
   *  MUST be awaited before relaunchApp()/exitApp() below (C2, code review). electron's app.exit()
   *  (unlike app.quit()) never fires 'before-quit', which is the ONLY place index.ts's own
   *  pgQuitDrain teardown is wired up — so without this explicit await, a switch-triggered exit
   *  would skip pool draining entirely and could cut an in-flight write. */
  drainDb: () => Promise<void>
  /** electron's app.relaunch() / app.exit(), called (in that order, AFTER drainDb above) after a
   *  successful backend switch — kept as two separate functions (rather than one combined "restart"
   *  fn) so a test can assert BOTH were actually invoked (plan-advisor H2), not just that "something"
   *  ran. */
  relaunchApp: () => void
  exitApp: () => void
  dashboardSummary: () => Promise<DashboardSummary>
  // v0.4.0
  searchRuns: (filters: RunSearchFilters) => Promise<RunLogWithJob[]>
  jobRunDurationTrend: (jobId: number) => Promise<RunDurationTrendPoint[]>
  jobIo: JobIoService
}

export function handleGetVersion(meta: { name: string; version: string }): AppVersion {
  return { name: meta.name, version: meta.version }
}

export const MAX_RUN_LIST_LIMIT = 1000

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const isStr = (v: unknown): v is string => typeof v === 'string'
// A schedule expr / command is written verbatim into the native scheduler line — an embedded
// newline (\n) OR carriage return (\r) would inject a second entry. Reject both at the boundary
// (code review #1 / #10 — a bare \r is treated as a line break by crontab parsers).
const isLine = (v: unknown): v is string => isStr(v) && !v.includes('\n') && !v.includes('\r')
const isOptStr = (v: unknown): boolean => v === undefined || isStr(v)
const bad = (msg: string): WriteResult => ({ ok: false, reason: 'error', errorCode: 'invalid_input', error: msg })
const badBatch = (msg: string): BatchWriteResult => ({ ok: false, reason: 'error', errorCode: 'invalid_input', error: msg, adopted: [] })

function isCreateInput(p: unknown): p is CreateJobInput {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return isStr(o.name) && isLine(o.scheduleExpr) && isLine(o.command) &&
    (o.notifyOnFailure === undefined || typeof o.notifyOnFailure === 'boolean')
}
function isAdoptItem(p: unknown): p is AdoptItem {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return isLine(o.scheduleExpr) && isLine(o.command) && isOptStr(o.name) && (o.category === undefined || isStr(o.category))
}
function isUpdateChanges(c: unknown): c is UpdateJobChanges {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  const lineOk = (v: unknown) => v === undefined || isLine(v)
  return (
    isOptStr(o.name) && lineOk(o.scheduleExpr) && lineOk(o.command) && isOptStr(o.workingDir) && isOptStr(o.category) &&
    (o.timeoutSec === undefined || (typeof o.timeoutSec === 'number' && Number.isInteger(o.timeoutSec))) &&
    (o.env === undefined || (typeof o.env === 'object' && o.env !== null)) &&
    (o.notifyOnFailure === undefined || typeof o.notifyOnFailure === 'boolean')
  )
}

export async function handleJobsCreate(deps: IpcDeps, payload: unknown): Promise<WriteResult & { job?: unknown }> {
  if (!isCreateInput(payload)) return bad('invalid CreateJobInput')
  return deps.service.create(payload)
}
export async function handleJobsUpdate(deps: IpcDeps, payload: unknown): Promise<WriteResult & { job?: unknown }> {
  const p = payload as { id?: unknown; changes?: unknown }
  if (!isPosInt(p?.id) || !isUpdateChanges(p.changes)) return bad('invalid update payload')
  return deps.service.update(p.id, p.changes)
}
export async function handleJobsEnable(deps: IpcDeps, payload: unknown): Promise<WriteResult> {
  const id = (payload as { id?: unknown })?.id
  return isPosInt(id) ? deps.service.enable(id) : bad('invalid id')
}
export async function handleJobsDisable(deps: IpcDeps, payload: unknown): Promise<WriteResult> {
  const id = (payload as { id?: unknown })?.id
  return isPosInt(id) ? deps.service.disable(id) : bad('invalid id')
}
export async function handleJobsDelete(deps: IpcDeps, payload: unknown): Promise<WriteResult> {
  const id = (payload as { id?: unknown })?.id
  return isPosInt(id) ? deps.service.remove(id) : bad('invalid id')
}
export async function handleJobsAdopt(deps: IpcDeps, payload: unknown): Promise<BatchWriteResult> {
  const items = (payload as { items?: unknown })?.items
  if (!Array.isArray(items) || items.length === 0) return badBatch('items must be a non-empty array')
  if (items.length > MAX_BATCH_ADOPT) return badBatch(`at most ${MAX_BATCH_ADOPT} items`)
  if (!items.every(isAdoptItem)) return badBatch('invalid AdoptItem in batch')
  return deps.service.adopt(items)
}
export async function handleJobsUnadopt(deps: IpcDeps, payload: unknown): Promise<WriteResult> {
  const id = (payload as { id?: unknown })?.id
  return isPosInt(id) ? deps.service.unadopt(id) : bad('invalid id')
}
export async function handleJobsForget(deps: IpcDeps, payload: unknown): Promise<WriteResult> {
  const id = (payload as { id?: unknown })?.id
  return isPosInt(id) ? deps.service.forget(id) : bad('invalid id')
}
export async function handleJobsRunNow(deps: IpcDeps, payload: unknown): Promise<RunNowResult> {
  const id = (payload as { id?: unknown })?.id
  if (!isPosInt(id)) throw new Error('invalid id')
  return deps.runNow(id)
}
export async function handleJobsRunNowStreaming(deps: IpcDeps, payload: unknown): Promise<void> {
  const id = (payload as { id?: unknown })?.id
  if (!isPosInt(id)) throw new Error('invalid id')
  return deps.runNowStreaming(id)
}
export function handleJobsRunBatchCancel(deps: IpcDeps): void {
  deps.cancelBatch()
}
export async function handleJobsList(deps: IpcDeps): Promise<ReconcileResult> {
  return deps.service.list()
}
export function handleRunsListForJob(deps: IpcDeps, payload: unknown): Promise<RunLog[]> {
  const p = payload as { jobId?: unknown; limit?: unknown }
  if (!isPosInt(p?.jobId)) throw new Error('invalid jobId') // sync throw at the boundary (kept non-async)
  const limit = isPosInt(p.limit) ? Math.min(p.limit, MAX_RUN_LIST_LIMIT) : undefined // cap (code review #5)
  return deps.listRunsForJob(p.jobId, limit)
}
export function handleRunsRecent(deps: IpcDeps, payload: unknown): Promise<RunLog[]> {
  const p = payload as { limit?: unknown }
  const limit = isPosInt(p?.limit) ? Math.min(p.limit as number, MAX_RUN_LIST_LIMIT) : undefined
  return deps.recentRuns(limit)
}

const isWindow = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
// The bot token is interpolated into the Telegram API URL path (Go side: fmt.Sprintf(".../bot%s/...")),
// so a token carrying '/', '..' or query chars could reshape the request path. The chatId selects the
// notification recipient. Validate both formats at the IPC boundary so a compromised renderer can't
// smuggle a malformed value into the URL or redirect alerts (code review #7). Formats are shared with
// notify.service (testSend) via ../shared/notify-validation so every URL-building site agrees.
const isNotifyToken = (v: unknown): v is string => isStr(v) && isNotifyTokenFormat(v)
const isChatId = (v: unknown): v is string => isStr(v) && isChatIdFormat(v)
function isNotifyInput(p: unknown): p is NotifySaveInput {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  // token === undefined | '' means "keep the existing token" (see notify.service saveSettings),
  // so a format check only applies to a non-empty token string.
  return typeof o.enabled === 'boolean' && (o.chatId === null || isChatId(o.chatId)) && isWindow(o.windowMin) &&
    (o.includeStderr === undefined || typeof o.includeStderr === 'boolean') &&
    (o.nativeEnabled === undefined || typeof o.nativeEnabled === 'boolean') &&
    (o.token === undefined || o.token === '' || isNotifyToken(o.token))
}
export async function handleNotifyGet(deps: IpcDeps) { return deps.notify.getSettings() }
export async function handleNotifySave(deps: IpcDeps, payload: unknown) {
  if (!isNotifyInput(payload)) return { ok: false as const, error: 'invalid notify settings' }
  return deps.notify.saveSettings(payload)
}
export async function handleNotifyTest(deps: IpcDeps) { return deps.notify.testSend() }
export async function handleJobsManagedCount(deps: IpcDeps): Promise<number> {
  return deps.service.managedCount()
}

// ---------------------------------------------------------------------------------------------
// T13 — pg settings UI: test-connection + save/switch. Password validation deliberately stays
// format-only (never echoed back in any error string here — see the handlers below), and the raw
// fields never leave this module except folded into a DSN string handed to backend-switch.ts.
// ---------------------------------------------------------------------------------------------
const PG_SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'])
const isPort = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535
function isPgFields(p: unknown): p is PgDsnParts {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return (
    isStr(o.host) && o.host.length > 0 &&
    isPort(o.port) &&
    isStr(o.database) && o.database.length > 0 &&
    isStr(o.user) && o.user.length > 0 &&
    isStr(o.password) &&
    isStr(o.sslmode) && PG_SSLMODES.has(o.sslmode)
  )
}

export async function handlePgTestConnection(deps: IpcDeps, payload: unknown): Promise<TestConnectionResult> {
  if (!isPgFields(payload)) return { ok: false, error: 'invalid connection fields' }
  return deps.pgTestConnection(buildDsn(payload))
}

export async function handlePgSaveSwitch(deps: IpcDeps, payload: unknown): Promise<PgSaveSwitchResult> {
  const p = payload as Partial<PgSaveSwitchInput> | null | undefined
  if (!p || typeof p !== 'object') return { ok: false, error: 'invalid payload' }
  if (p.targetBackend !== 'postgres' && p.targetBackend !== 'sqlite') return { ok: false, error: 'invalid targetBackend' }

  // I3 (code review): reject a switch to the backend that's already active. Without this guard, a
  // resubmitted targetBackend equal to the currently-running backend would call pgSwitchToPostgres/
  // pgSwitchToSqlite against a live `sqliteHandle` that is — despite the name — ALREADY a postgres
  // handle once the process booted postgres, purely because the field happens to be present either
  // way; it "works" only by accident of both dialects sharing a handle shape.
  const { activeBackend } = await deps.pgGetStatus()
  if (p.targetBackend === activeBackend) {
    return { ok: false, error: activeBackend === 'postgres' ? 'Already using PostgreSQL backend' : 'Already using SQLite backend' }
  }

  if (p.targetBackend === 'sqlite') {
    const res = await deps.pgSwitchToSqlite()
    if (!res.ok) return { ok: false, error: res.error }
    // C2: drain a live postgres pool BEFORE relaunch/exit — app.exit() never fires 'before-quit'
    // (the only place index.ts's own pgQuitDrain teardown runs), so without this the pool would
    // never be drained on this path.
    await deps.drainDb()
    deps.relaunchApp()
    deps.exitApp()
    return { ok: true }
  }

  if (!isPgFields(p.fields)) return { ok: false, error: 'invalid connection fields' }
  if (typeof p.copyData !== 'boolean') return { ok: false, error: 'invalid copyData' }
  const res = await deps.pgSwitchToPostgres({ dsn: buildDsn(p.fields), copy: p.copyData })
  if (!res.ok) return { ok: false, error: res.error }
  await deps.drainDb()
  deps.relaunchApp()
  deps.exitApp()
  return { ok: true }
}

// T15 — pg settings UI status read: a thin pass-through, kept as its own handler (rather than
// inlined into registerIpcHandlers) so it is unit-testable the same way as every other handler here.
export async function handlePgGetStatus(deps: IpcDeps): Promise<PgStatus> {
  return deps.pgGetStatus()
}

// Task 5 — dashboard summary: a thin pass-through (same shape as handlePgGetStatus above), kept as
// its own named handler per this file's "every channel gets a named handler" convention rather than
// inlined into registerIpcHandlers.
export function handleDashboardSummary(deps: IpcDeps): Promise<DashboardSummary> {
  return deps.dashboardSummary()
}

// ---------------------------------------------------------------------------------------------
// v0.4.0 — Run History search, run-duration trend, YAML import/export.
// ---------------------------------------------------------------------------------------------
const isResultEnum = (v: unknown): v is 'success' | 'failure' | 'timeout' =>
  v === 'success' || v === 'failure' || v === 'timeout'

function isRunSearchInput(p: unknown): p is RunSearchInput {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return (
    (o.jobId === undefined || isPosInt(o.jobId)) &&
    (o.result === undefined || isResultEnum(o.result)) &&
    (o.since === undefined || (typeof o.since === 'number' && Number.isFinite(o.since))) &&
    (o.searchText === undefined || isStr(o.searchText)) &&
    (o.limit === undefined || isPosInt(o.limit))
  )
}
export async function handleRunsSearch(deps: IpcDeps, payload: unknown): Promise<RunLogWithJob[]> {
  if (!isRunSearchInput(payload)) throw new Error('invalid search filters')
  const limit = payload.limit !== undefined ? Math.min(payload.limit, MAX_RUN_LIST_LIMIT) : RUN_SEARCH_PAGE_SIZE
  return deps.searchRuns({
    jobId: payload.jobId,
    result: payload.result,
    since: payload.since !== undefined ? new Date(payload.since) : undefined,
    searchText: payload.searchText,
    limit
  })
}

export async function handleJobsRunDurationTrend(deps: IpcDeps, payload: unknown): Promise<RunDurationTrendPoint[]> {
  const id = (payload as { jobId?: unknown } | undefined)?.jobId
  if (!isPosInt(id)) throw new Error('invalid jobId')
  return deps.jobRunDurationTrend(id)
}

export async function handleJobsExportYaml(deps: IpcDeps, payload: unknown): Promise<ExportYamlResult> {
  const p = payload as { jobIds?: unknown } | undefined
  let jobIds: number[] | undefined
  if (p?.jobIds !== undefined) {
    if (!Array.isArray(p.jobIds) || !p.jobIds.every(isPosInt)) return { status: 'error', error: 'invalid jobIds' }
    jobIds = p.jobIds as number[]
  }
  return deps.jobIo.exportJobs(jobIds)
}

export async function handleJobsImportPreview(deps: IpcDeps): Promise<ImportPreviewResult> {
  return deps.jobIo.previewImport()
}

// Mirrors isCreateInput's shape check (same required fields, same isLine newline-injection guard on
// scheduleExpr/command) plus the extra optional `enabled` YamlJobEntry carries.
function isYamlJobEntry(p: unknown): p is YamlJobEntry {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return (
    isStr(o.name) && isLine(o.scheduleExpr) && isLine(o.command) && isOptStr(o.workingDir) && isOptStr(o.category) &&
    (o.env === undefined || (typeof o.env === 'object' && o.env !== null)) &&
    (o.timeoutSec === undefined || (typeof o.timeoutSec === 'number' && Number.isInteger(o.timeoutSec))) &&
    (o.notifyOnFailure === undefined || typeof o.notifyOnFailure === 'boolean') &&
    (o.enabled === undefined || typeof o.enabled === 'boolean')
  )
}
export async function handleJobsImportApply(deps: IpcDeps, payload: unknown): Promise<ImportApplyResult> {
  const p = payload as { entries?: unknown } | undefined
  if (!p || !Array.isArray(p.entries) || p.entries.length === 0 || !p.entries.every(isYamlJobEntry)) {
    return { ok: false, created: 0, updated: 0, errors: ['invalid import payload'] }
  }
  return deps.jobIo.applyImport(p.entries)
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.handle(IPC.appGetVersion, () => handleGetVersion(deps.meta))
  ipcMain.handle(IPC.jobsList, () => handleJobsList(deps))
  ipcMain.handle(IPC.jobsReconcile, () => handleJobsList(deps))
  ipcMain.handle(IPC.jobsCreate, (_e, p) => handleJobsCreate(deps, p))
  ipcMain.handle(IPC.jobsUpdate, (_e, p) => handleJobsUpdate(deps, p))
  ipcMain.handle(IPC.jobsEnable, (_e, p) => handleJobsEnable(deps, p))
  ipcMain.handle(IPC.jobsDisable, (_e, p) => handleJobsDisable(deps, p))
  ipcMain.handle(IPC.jobsDelete, (_e, p) => handleJobsDelete(deps, p))
  ipcMain.handle(IPC.jobsAdopt, (_e, p) => handleJobsAdopt(deps, p))
  ipcMain.handle(IPC.jobsUnadopt, (_e, p) => handleJobsUnadopt(deps, p))
  ipcMain.handle(IPC.jobsForget, (_e, p) => handleJobsForget(deps, p))
  ipcMain.handle(IPC.jobsRunNow, (_e, p) => handleJobsRunNow(deps, p))
  ipcMain.handle(IPC.runsListForJob, (_e, p) => handleRunsListForJob(deps, p))
  ipcMain.handle(IPC.runsRecent, (_e, p) => handleRunsRecent(deps, p))
  ipcMain.handle(IPC.jobsRunNowStreaming, (_e, p) => handleJobsRunNowStreaming(deps, p))
  ipcMain.handle(IPC.jobsRunBatchCancel, () => handleJobsRunBatchCancel(deps))
  ipcMain.handle(IPC.notifyGet, () => handleNotifyGet(deps))
  ipcMain.handle(IPC.notifySave, (_e, p) => handleNotifySave(deps, p))
  ipcMain.handle(IPC.notifyTest, () => handleNotifyTest(deps))
  ipcMain.handle(IPC.jobsManagedCount, () => handleJobsManagedCount(deps))
  ipcMain.handle(IPC.pgTestConnection, (_e, p) => handlePgTestConnection(deps, p))
  ipcMain.handle(IPC.pgSaveSwitch, (_e, p) => handlePgSaveSwitch(deps, p))
  ipcMain.handle(IPC.pgGetStatus, () => handlePgGetStatus(deps))
  ipcMain.handle(IPC.dashboardSummary, () => handleDashboardSummary(deps))
  ipcMain.handle(IPC.runsSearch, (_e, p) => handleRunsSearch(deps, p))
  ipcMain.handle(IPC.jobsRunDurationTrend, (_e, p) => handleJobsRunDurationTrend(deps, p))
  ipcMain.handle(IPC.jobsExportYaml, (_e, p) => handleJobsExportYaml(deps, p))
  ipcMain.handle(IPC.jobsImportPreview, () => handleJobsImportPreview(deps))
  ipcMain.handle(IPC.jobsImportApply, (_e, p) => handleJobsImportApply(deps, p))
}

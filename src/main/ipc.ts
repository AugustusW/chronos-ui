// SPDX-License-Identifier: Apache-2.0
import { ipcMain } from 'electron'
import { IPC, type AppVersion } from '../shared/ipc-contract'
import type { CreateJobInput, UpdateJobChanges, AdoptItem, ReconcileResult, RunNowResult } from '../shared/ipc-contract'
import type { JobsService } from './services/jobs.service'
import type { NotifyService, NotifySaveInput } from './services/notify.service'
import type { RunLog } from './db/schema'
import type { WriteResult, BatchWriteResult } from './scheduler/types'

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
}

export function handleGetVersion(meta: { name: string; version: string }): AppVersion {
  return { name: meta.name, version: meta.version }
}

export const MAX_RUN_LIST_LIMIT = 1000

const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const isStr = (v: unknown): v is string => typeof v === 'string'
// A schedule expr / command is written verbatim into the native scheduler line — an embedded
// newline would inject a second entry. Reject it at the boundary (code review #1).
const isLine = (v: unknown): v is string => isStr(v) && !v.includes('\n')
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
  return isLine(o.scheduleExpr) && isLine(o.command) && isOptStr(o.name)
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
function isNotifyInput(p: unknown): p is NotifySaveInput {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o.enabled === 'boolean' && (o.chatId === null || isStr(o.chatId)) && isWindow(o.windowMin) &&
    (o.token === undefined || isStr(o.token))
}
export async function handleNotifyGet(deps: IpcDeps) { return deps.notify.getSettings() }
export async function handleNotifySave(deps: IpcDeps, payload: unknown) {
  if (!isNotifyInput(payload)) return { ok: false as const, error: 'invalid notify settings' }
  return deps.notify.saveSettings(payload)
}
export async function handleNotifyTest(deps: IpcDeps) { return deps.notify.testSend() }

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
  ipcMain.handle(IPC.jobsRunNow, (_e, p) => handleJobsRunNow(deps, p))
  ipcMain.handle(IPC.runsListForJob, (_e, p) => handleRunsListForJob(deps, p))
  ipcMain.handle(IPC.runsRecent, (_e, p) => handleRunsRecent(deps, p))
  ipcMain.handle(IPC.jobsRunNowStreaming, (_e, p) => handleJobsRunNowStreaming(deps, p))
  ipcMain.handle(IPC.jobsRunBatchCancel, () => handleJobsRunBatchCancel(deps))
  ipcMain.handle(IPC.notifyGet, () => handleNotifyGet(deps))
  ipcMain.handle(IPC.notifySave, (_e, p) => handleNotifySave(deps, p))
  ipcMain.handle(IPC.notifyTest, () => handleNotifyTest(deps))
}

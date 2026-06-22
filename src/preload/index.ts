// SPDX-License-Identifier: Apache-2.0
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc-contract'
import type {
  AppVersion, ReconcileResult, CreateJobInput, UpdateJobChanges, AdoptItem, RunNowResult, Job, RunLog, WriteResult, BatchWriteResult, RunEvent
} from '../shared/ipc-contract'

const api = {
  getVersion: (): Promise<AppVersion> => ipcRenderer.invoke(IPC.appGetVersion),
  listJobs: (): Promise<ReconcileResult> => ipcRenderer.invoke(IPC.jobsList),
  reconcile: (): Promise<ReconcileResult> => ipcRenderer.invoke(IPC.jobsReconcile),
  createJob: (input: CreateJobInput): Promise<WriteResult & { job?: Job }> => ipcRenderer.invoke(IPC.jobsCreate, input),
  updateJob: (id: number, changes: UpdateJobChanges): Promise<WriteResult & { job?: Job }> => ipcRenderer.invoke(IPC.jobsUpdate, { id, changes }),
  enableJob: (id: number): Promise<WriteResult> => ipcRenderer.invoke(IPC.jobsEnable, { id }),
  disableJob: (id: number): Promise<WriteResult> => ipcRenderer.invoke(IPC.jobsDisable, { id }),
  deleteJob: (id: number): Promise<WriteResult> => ipcRenderer.invoke(IPC.jobsDelete, { id }),
  adoptJobs: (items: AdoptItem[]): Promise<BatchWriteResult> => ipcRenderer.invoke(IPC.jobsAdopt, { items }),
  unadoptJob: (id: number): Promise<WriteResult> => ipcRenderer.invoke(IPC.jobsUnadopt, { id }),
  runNow: (id: number): Promise<RunNowResult> => ipcRenderer.invoke(IPC.jobsRunNow, { id }),
  listRuns: (jobId: number, limit?: number): Promise<RunLog[]> => ipcRenderer.invoke(IPC.runsListForJob, { jobId, limit }),
  recentRuns: (limit?: number): Promise<RunLog[]> => ipcRenderer.invoke(IPC.runsRecent, { limit }),
  runNowStreaming: (id: number): Promise<void> => ipcRenderer.invoke(IPC.jobsRunNowStreaming, { id }),
  cancelBatch: (): Promise<void> => ipcRenderer.invoke(IPC.jobsRunBatchCancel),
  onRunEvent: (cb: (e: RunEvent) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, payload: RunEvent): void => cb(payload)
    ipcRenderer.on(IPC.runEvent, h)
    return () => ipcRenderer.removeListener(IPC.runEvent, h)
  }
}

contextBridge.exposeInMainWorld('chronos', api)

export type ChronosApi = typeof api

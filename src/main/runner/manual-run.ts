// SPDX-License-Identifier: Apache-2.0
import type { JobsRepo, RunLogsRepo } from '../db/repositories'
import type { RunNowResult, RunEvent } from '../../shared/ipc-contract'

// Monotonic counter for synthetic live-event ids (NOT DB ids; keying only).
let _seq = 0
const defaultNextId = (): number => ++_seq

/** Minimal child shape we depend on — real `child_process.spawn` returns a superset. */
export interface ChildLike {
  on(event: 'exit', cb: (code: number | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  /** Best-effort kill if the UI cap fires, so schedmgr isn't left running as an orphan (review #9). */
  kill?(signal?: NodeJS.Signals | number): void
}
export type SpawnLike = (cmd: string, args: string[]) => ChildLike

export interface RunNowDeps {
  jobs: JobsRepo
  runLogs: RunLogsRepo
  schedmgrPath: string
  dbPath: string
  spawn: SpawnLike
  graceMs?: number // added to the job timeout for the UI wait
  hardFloorMs?: number // minimum UI wait
  delay?: (ms: number, cb: () => void) => void // injectable timer (tests pass a synchronous stub)
}

/**
 * Manual run (spec §6, design §6.1): spawn schedmgr with --triggered-by manual, await exit, return
 * the row schedmgr wrote. UI hard-cap (architect MEDIUM #5) prevents a no-timeout job from hanging
 * the IPC response. Command source is the DB `job.command` (architect HIGH #2).
 */
export async function runNow(id: number, deps: RunNowDeps): Promise<RunNowResult> {
  const job = await deps.jobs.get(id)
  if (!job) throw new Error(`no job ${id}`) // unmanaged/unknown ids are rejected at the boundary

  const args = [
    'run', String(id), '--db', deps.dbPath, '--triggered-by', 'manual',
    ...(job.timeoutSec ? ['--timeout', String(job.timeoutSec)] : []),
    '--', job.command
  ]

  const child = deps.spawn(deps.schedmgrPath, args)
  const grace = deps.graceMs ?? 30_000
  const floor = deps.hardFloorMs ?? 60_000
  const cap = Math.max((job.timeoutSec ?? 0) * 1000 + grace, floor)
  // unref the cap timer so a normal exit doesn't leave it holding the event loop open for the full
  // cap (it just resolves an already-settled race). Matches runNowStreaming (review #9 follow-up).
  const delay = deps.delay ?? ((ms, cb) => { setTimeout(cb, ms).unref?.() })

  type Outcome = { t: 'exit' } | { t: 'timeout' } | { t: 'error'; err: Error }
  const exited = new Promise<Outcome>((resolve) => child.on('exit', () => resolve({ t: 'exit' })))
  const timedOut = new Promise<Outcome>((resolve) => delay(cap, () => resolve({ t: 'timeout' })))
  // Node emits 'error' (not 'exit') when the binary can't be spawned (ENOENT — e.g. an unresolved
  // schedmgr path before Plan 7 packaging). Without this branch, runNow would wait the full UI cap
  // and the IPC call would hang (code review #2).
  const failed = new Promise<Outcome>((resolve) => child.on('error', (err) => resolve({ t: 'error', err })))
  const outcome = await Promise.race([exited, timedOut, failed])

  if (outcome.t === 'error') {
    throw new Error(`failed to spawn schedmgr at ${deps.schedmgrPath}: ${outcome.err.message}`)
  }
  if (outcome.t === 'timeout') {
    // The UI cap fired before schedmgr exited — kill it so it isn't left running as an orphan past
    // the cap (review #9). It still records its own result best-effort if it was mid-run.
    child.kill?.()
    return { status: 'ui_timeout', jobId: id, waitedMs: cap }
  }
  const run = await deps.runLogs.getLatest(id)
  if (!run) return { status: 'ui_timeout', jobId: id, waitedMs: cap } // schedmgr exited without a row (best-effort DB failure)
  return { status: 'completed', run }
}

export interface StreamingChildLike extends ChildLike {
  stdout: { on(ev: 'data', cb: (b: Buffer) => void): unknown } | null
  stderr: { on(ev: 'data', cb: (b: Buffer) => void): unknown } | null
}
export type SpawnStreamingLike = (cmd: string, args: string[]) => StreamingChildLike

export interface RunStreamingDeps {
  jobs: JobsRepo
  schedmgrPath: string
  dbPath: string
  spawn: SpawnStreamingLike
  emit: (e: RunEvent) => void
  now?: () => number
  /** Injectable id source for live-event keying. Defaults to a module-level monotonic counter.
   *  The returned value is a synthetic id (NOT a DB run_logs id). */
  nextId?: () => number
  graceMs?: number // added to the job timeout for the UI safety-net wait (mirrors runNow)
  hardFloorMs?: number // minimum UI wait
  delay?: (ms: number, cb: () => void) => void // injectable timer (tests pass a synchronous stub)
}

/**
 * Live manual run (spec §6, design §4): spawn schedmgr with piped stdio, forward stdout/stderr as
 * `output` events, emit started/finished. The command is the DB job.command (architect HIGH-2).
 * schedmgr remains the SOLE writer of the authoritative run_logs row (consistent with runNow).
 * This function writes NO DB row; events are keyed by a synthetic monotonic id (not a DB id).
 */
export async function runNowStreaming(id: number, deps: RunStreamingDeps): Promise<void> {
  const job = await deps.jobs.get(id)
  if (!job) throw new Error(`no job ${id}`)
  const now = deps.now ?? (() => Date.now())
  // Use a synthetic id purely to key live events; it is NOT stored in run_logs.
  const syntheticRunId = (deps.nextId ?? defaultNextId)()
  deps.emit({ kind: 'started', jobId: id, runId: syntheticRunId, triggeredBy: 'manual', startedAt: now() })
  const args = [
    'run', String(id), '--db', deps.dbPath, '--triggered-by', 'manual',
    ...(job.timeoutSec ? ['--timeout', String(job.timeoutSec)] : []),
    '--', job.command
  ]
  const child = deps.spawn(deps.schedmgrPath, args)
  child.stdout?.on('data', (b) => deps.emit({ kind: 'output', runId: syntheticRunId, stream: 'stdout', chunk: b.toString() }))
  child.stderr?.on('data', (b) => deps.emit({ kind: 'output', runId: syntheticRunId, stream: 'stderr', chunk: b.toString() }))
  // UI safety net (mirrors runNow): if neither exit nor error fires within the cap (a hung schedmgr),
  // kill it and finish — otherwise this Promise and the live run would hang forever (review #9).
  const grace = deps.graceMs ?? 30_000
  const floor = deps.hardFloorMs ?? 60_000
  const cap = Math.max((job.timeoutSec ?? 0) * 1000 + grace, floor)
  // unref the safety-net timer so a run that exits normally doesn't leave it holding the event loop
  // open (it fires once and no-ops after settled).
  const delay = deps.delay ?? ((ms, cb) => { setTimeout(cb, ms).unref?.() })
  // Guard against double-emit if more than one of exit / error / timeout fires (Node's EventEmitter
  // doesn't strictly prevent it, and the timeout races the others).
  let settled = false
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      const result = code === 0 ? 'success' : 'failure'
      deps.emit({ kind: 'finished', runId: syntheticRunId, result, exitCode: code, endedAt: now() })
      resolve()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      deps.emit({ kind: 'finished', runId: syntheticRunId, result: 'failure', exitCode: null, endedAt: now() })
      reject(new Error(`failed to spawn schedmgr: ${err.message}`))
    })
    delay(cap, () => {
      if (settled) return
      settled = true
      child.kill?.()
      deps.emit({ kind: 'finished', runId: syntheticRunId, result: 'failure', exitCode: null, endedAt: now() })
      resolve()
    })
  })
}

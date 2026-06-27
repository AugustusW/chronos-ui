// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { makeTestDb } from '../db/helpers'
import { createRepositories } from '../../src/main/db/repositories'
import { createJob } from '../../src/main/db/jobs.repository'
import { startRun, finishRun, getLatestRun } from '../../src/main/db/runLogs.repository'
import { runNow, runNowStreaming } from '../../src/main/runner/manual-run'

const seed = (db: ReturnType<typeof makeTestDb>['db'], over = {}) =>
  createJob(db, { name: 'B', source: 'native_cron', platform: 'darwin', scheduleExpr: '0 3 * * *', command: '/b.sh', enabled: true, adopted: true, ...over })

describe('runNow', () => {
  it('rejects an unknown id (architect HIGH #2 — DB-tracked ids only)', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    await expect(runNow(123, { jobs: repos.jobs, runLogs: repos.runLogs, schedmgrPath: '/s', dbPath: '/db', spawn: () => { throw new Error('should not spawn') } }))
      .rejects.toThrow(/no job/)
    await h.close()
  })

  it('builds the argv-array (no shell) and returns the row schedmgr wrote on exit', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const job = seed(h.db, { timeoutSec: 30 })
    let gotArgs: string[] = []
    const child = new EventEmitter()
    const spawn = (_cmd: string, args: string[]) => {
      gotArgs = args
      queueMicrotask(() => {
        // simulate schedmgr writing its own run_log, then exiting
        const r = startRun(h.db, { jobId: job.id, triggeredBy: 'manual' })
        finishRun(h.db, r.id, { result: 'success', exitCode: 0, stdout: 'ok', stderr: '' })
        child.emit('exit', 0)
      })
      return child as never
    }

    const res = await runNow(job.id, { jobs: repos.jobs, runLogs: repos.runLogs, schedmgrPath: '/opt/schedmgr', dbPath: '/db/chronos.db', spawn })
    expect(gotArgs).toEqual(['run', String(job.id), '--db', '/db/chronos.db', '--triggered-by', 'manual', '--timeout', '30', '--', '/b.sh'])
    expect(res.status).toBe('completed')
    if (res.status === 'completed') expect(res.run.result).toBe('success')
    await h.close()
  })

  it('returns ui_timeout when the child never exits within the hard cap', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const job = seed(h.db)
    const child = new EventEmitter()
    const spawn = () => child as never
    const res = await runNow(job.id, { jobs: repos.jobs, runLogs: repos.runLogs, schedmgrPath: '/s', dbPath: '/db', spawn, delay: (_ms, cb) => cb() })
    expect(res.status).toBe('ui_timeout')
    if (res.status === 'ui_timeout') expect(res.jobId).toBe(job.id)
    await h.close()
  })

  it('throws (does not hang) when the binary fails to spawn — ENOENT emits "error", not "exit"', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const job = seed(h.db)
    const child = new EventEmitter()
    // never resolve the timeout: prove the throw comes from the 'error' branch, not the UI cap.
    const spawn = () => { queueMicrotask(() => child.emit('error', new Error('spawn /nope ENOENT'))); return child as never }
    await expect(runNow(job.id, { jobs: repos.jobs, runLogs: repos.runLogs, schedmgrPath: '/nope', dbPath: '/db', spawn, delay: () => {} }))
      .rejects.toThrow(/failed to spawn schedmgr/i)
    await h.close()
  })
})

describe('runNowStreaming', () => {
  it('emits started → output chunks → finished, sourcing the command from the DB', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const job = seed(h.db, { timeoutSec: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    let gotArgs: string[] = []
    const spawn = (_c: string, args: string[]) => {
      gotArgs = args
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('hello\n'))
        child.stderr.emit('data', Buffer.from('warn\n'))
        child.emit('exit', 0)
      })
      return child
    }
    await runNowStreaming(job.id, { jobs: repos.jobs, schedmgrPath: '/s', dbPath: '/db', spawn, emit: (e) => events.push(e) })
    expect(gotArgs).toContain('--triggered-by'); expect(gotArgs).toContain('manual')
    expect(events.map((e) => e.kind)).toEqual(['started', 'output', 'output', 'finished'])
    expect(events[1]).toMatchObject({ stream: 'stdout', chunk: 'hello\n' })
    expect(events.at(-1)).toMatchObject({ kind: 'finished', exitCode: 0 })
    // runNowStreaming writes NO DB row — schedmgr is the sole row writer.
    const latest = getLatestRun(h.db, job.id)
    expect(latest).toBeUndefined()
    // The synthetic runId emitted to the UI must be a positive number (not a DB id).
    expect(events[0].runId).toBeGreaterThan(0)
    await h.close()
  })
  it('two successive runs emit distinct (monotonic) synthetic runIds', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const job = seed(h.db, { timeoutSec: 0 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeChild = () => { const c: any = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); return c }
    const makeSpawn = (c: ReturnType<typeof makeChild>) => (_cmd: string, _args: string[]) => { queueMicrotask(() => c.emit('exit', 0)); return c }

    let seq = 0
    const nextId = () => ++seq

    const events1: { runId: number }[] = []
    const child1 = makeChild()
    await runNowStreaming(job.id, { jobs: repos.jobs, schedmgrPath: '/s', dbPath: '/db', spawn: makeSpawn(child1), emit: (e) => events1.push(e as never), nextId })

    const events2: { runId: number }[] = []
    const child2 = makeChild()
    await runNowStreaming(job.id, { jobs: repos.jobs, schedmgrPath: '/s', dbPath: '/db', spawn: makeSpawn(child2), emit: (e) => events2.push(e as never), nextId })

    expect(events1[0].runId).toBeGreaterThan(0)
    expect(events2[0].runId).toBeGreaterThan(0)
    expect(events2[0].runId).toBeGreaterThan(events1[0].runId) // monotonic / distinct
    await h.close()
  })
  it('rejects an unknown id without spawning', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    await expect(runNowStreaming(999, { jobs: repos.jobs, schedmgrPath: '/s', dbPath: '/db', spawn: () => { throw new Error('no') }, emit: () => {} }))
      .rejects.toThrow(/no job/)
    await h.close()
  })
  it('rejects with a descriptive error and emits finished:failure when spawn emits error (ENOENT)', async () => {
    const h = makeTestDb()
    const repos = createRepositories(h)
    const job = seed(h.db)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    const spawn = () => { queueMicrotask(() => child.emit('error', new Error('ENOENT'))); return child }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = []
    await expect(
      runNowStreaming(job.id, { jobs: repos.jobs, schedmgrPath: '/nope', dbPath: '/db', spawn, emit: (e) => events.push(e) })
    ).rejects.toThrow(/spawn/i)
    // finished event must be emitted exactly once with result:'failure'
    const finished = events.filter((e) => e.kind === 'finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ kind: 'finished', result: 'failure', exitCode: null })
    await h.close()
  })
})

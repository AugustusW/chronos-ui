// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listJobs = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
beforeEach(() => { (globalThis as any).window = { chronos: { listJobs } } })

import { createScheduleStore } from '../../src/renderer/src/stores/schedule.store'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const item = (over: any = {}) => ({ status: 'in_sync', job: { id: 1, name: 'B', category: 'backups', scheduleExpr: '0 3 * * *', command: '/b', enabled: true, adopted: true, lastResult: 'success', ...over.job }, native: {}, ...over })

describe('schedule store', () => {
  it('refresh() loads the reconcile result and derives categories', async () => {
    listJobs.mockResolvedValue({ items: [item(), item({ job: { id: 2, name: 'C', category: 'web' } })], generatedAt: 0 })
    const s = createScheduleStore()
    await s.refresh()
    expect(s.items.length).toBe(2)
    expect(s.categories).toEqual(expect.arrayContaining(['backups', 'web']))
  })
  it('category filter narrows visibleGroups', async () => {
    listJobs.mockResolvedValue({ items: [item(), item({ job: { id: 2, name: 'C', category: 'web' } })], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    s.setCategory('web')
    expect(s.visibleGroups.flatMap((g) => g.items).length).toBe(1)
  })
  it('applyRunEvent marks a job running then finished', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    s.applyRunEvent({ kind: 'started', jobId: 1, runId: 9, triggeredBy: 'manual', startedAt: 0 })
    expect(s.runningRuns.has(1)).toBe(true)
    s.applyRunEvent({ kind: 'finished', runId: 9, result: 'success', exitCode: 0, endedAt: 1 })
    expect(s.runningRuns.has(1)).toBe(false)
  })
  it('jobsChanged triggers a refresh', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    listJobs.mockClear()
    s.applyRunEvent({ kind: 'jobsChanged' })
    expect(listJobs).toHaveBeenCalled()
  })
  it('output event appends to the correct stream after started', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    s.applyRunEvent({ kind: 'started', jobId: 1, runId: 9, triggeredBy: 'manual', startedAt: 0 })
    s.applyRunEvent({ kind: 'output', runId: 9, stream: 'stdout', chunk: 'hello\n' })
    expect(s.liveOutput.get(9)?.stdout).toBe('hello\n')
    expect(s.liveOutput.get(9)?.stderr).toBe('')
  })
  it('successive output events accumulate; stderr is independent', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    s.applyRunEvent({ kind: 'started', jobId: 1, runId: 9, triggeredBy: 'manual', startedAt: 0 })
    s.applyRunEvent({ kind: 'output', runId: 9, stream: 'stdout', chunk: 'hello\n' })
    s.applyRunEvent({ kind: 'output', runId: 9, stream: 'stdout', chunk: 'world\n' })
    s.applyRunEvent({ kind: 'output', runId: 9, stream: 'stderr', chunk: 'err\n' })
    expect(s.liveOutput.get(9)?.stdout).toBe('hello\nworld\n')
    expect(s.liveOutput.get(9)?.stderr).toBe('err\n')
  })
  it('finished does NOT wipe liveOutput for the run', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    s.applyRunEvent({ kind: 'started', jobId: 1, runId: 9, triggeredBy: 'manual', startedAt: 0 })
    s.applyRunEvent({ kind: 'output', runId: 9, stream: 'stdout', chunk: 'hello\n' })
    s.applyRunEvent({ kind: 'finished', runId: 9, result: 'success', exitCode: 0, endedAt: 1 })
    expect(s.liveOutput.get(9)?.stdout).toBe('hello\n')
  })

  it('liveOutput map is capped at LIVE_OUTPUT_MAX (50) after many started events', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    // Fire 60 started + immediately finished events (no run stays active)
    for (let i = 1; i <= 60; i++) {
      s.applyRunEvent({ kind: 'started', jobId: 1, runId: i, triggeredBy: 'manual', startedAt: i })
      s.applyRunEvent({ kind: 'finished', runId: i, result: 'success', exitCode: 0, endedAt: i + 1 })
    }
    expect(s.liveOutput.size).toBeLessThanOrEqual(50)
  })

  it('liveOutput eviction never removes a still-running run', async () => {
    listJobs.mockResolvedValue({ items: [item()], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    // Start a special run on jobId=1000 and keep it running (no finished event)
    const RUNNING_JOB_ID = 1000
    const RUNNING_RUN_ID = 999
    s.applyRunEvent({ kind: 'started', jobId: RUNNING_JOB_ID, runId: RUNNING_RUN_ID, triggeredBy: 'manual', startedAt: 0 })
    s.applyRunEvent({ kind: 'output', runId: RUNNING_RUN_ID, stream: 'stdout', chunk: 'live\n' })
    // Now fire 55 other started+finished events on distinct jobIds to overflow the cap
    for (let i = 1; i <= 55; i++) {
      s.applyRunEvent({ kind: 'started', jobId: i, runId: i, triggeredBy: 'manual', startedAt: i })
      s.applyRunEvent({ kind: 'finished', runId: i, result: 'success', exitCode: 0, endedAt: i + 1 })
    }
    // The running run's buffer must survive
    expect(s.liveOutput.has(RUNNING_RUN_ID)).toBe(true)
    expect(s.liveOutput.get(RUNNING_RUN_ID)?.stdout).toBe('live\n')
    // Map size must still be bounded (cap + 1 protected running run)
    expect(s.liveOutput.size).toBeLessThanOrEqual(51)
  })

  it('refresh() toggles loading and records hasScanned (#2)', async () => {
    listJobs.mockResolvedValue({ items: [], generatedAt: 0 })
    const s = createScheduleStore()
    expect(s.loading).toBe(false)
    expect(s.hasScanned).toBe(false)
    const p = s.refresh()
    expect(s.loading).toBe(true)
    await p
    expect(s.loading).toBe(false)
    expect(s.hasScanned).toBe(true)
    expect(s.scanError).toBe(null)
  })

  it('refresh() captures scan errors instead of swallowing them (#2)', async () => {
    listJobs.mockRejectedValue(new Error('crontab read failed'))
    const s = createScheduleStore()
    await s.refresh()
    expect(s.scanError).toBe('crontab read failed')
    expect(s.loading).toBe(false)
  })

  it('unmanaged jobs group header is platform-aware (#3)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { chronos: { listJobs, platform: 'win32' } }
    listJobs.mockResolvedValue({ items: [item({ status: 'unmanaged', job: undefined, native: { scheduleExpr: '0 1 * * *', command: 'c' } })], generatedAt: 0 })
    const s = createScheduleStore(); await s.refresh()
    expect(s.visibleGroups.map((g) => g.category)).toContain('found in Task Scheduler')
  })
})

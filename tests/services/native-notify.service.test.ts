// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import {
  isNotifyWorthy,
  selectNewFailures,
  formatFailureNotification,
  createNativeNotifyService,
  type ScheduledFailure
} from '../../src/main/services/native-notify.service'
import type { RunOutcomeRow } from '../../src/main/db/repositories'
import type { NativeNotifier } from '../../src/main/services/native-notify.service'

const BASE = Date.parse('2026-08-01T09:00:00')

function row(over: Partial<RunOutcomeRow> = {}): RunOutcomeRow {
  return {
    jobId: 1,
    jobName: 'Backup',
    triggeredBy: 'schedule',
    result: 'failure',
    exitCode: 1,
    startedAt: new Date(BASE),
    ...over
  }
}

describe('isNotifyWorthy', () => {
  it('schedule-triggered failure/timeout are notify-worthy', () => {
    expect(isNotifyWorthy(row({ result: 'failure' }))).toBe(true)
    expect(isNotifyWorthy(row({ result: 'timeout' }))).toBe(true)
  })
  it('schedule-triggered success is not', () => {
    expect(isNotifyWorthy(row({ result: 'success' }))).toBe(false)
  })
  it('manual-triggered runs are never notify-worthy, even on failure — mirrors schedmgr/notify.go: "only for non-success, schedule-triggered runs" (a manual run\'s outcome is already visible live in the app)', () => {
    expect(isNotifyWorthy(row({ triggeredBy: 'manual', result: 'failure' }))).toBe(false)
    expect(isNotifyWorthy(row({ triggeredBy: 'manual', result: 'timeout' }))).toBe(false)
  })
})

describe('selectNewFailures', () => {
  it('picks only notify-worthy rows strictly newer than sinceTs', () => {
    const rows = [
      row({ jobId: 1, result: 'failure', startedAt: new Date(BASE + 1000) }),
      row({ jobId: 2, result: 'success', startedAt: new Date(BASE + 2000) }),
      row({ jobId: 3, triggeredBy: 'manual', result: 'failure', startedAt: new Date(BASE + 3000) }),
      row({ jobId: 4, result: 'timeout', startedAt: new Date(BASE + 4000) })
    ]
    const { toNotify } = selectNewFailures(rows, BASE)
    expect(toNotify.map((f) => f.jobId)).toEqual([1, 4])
  })

  it('excludes a row exactly AT sinceTs (exclusive boundary — the row was already processed last tick)', () => {
    const rows = [row({ startedAt: new Date(BASE) })]
    expect(selectNewFailures(rows, BASE).toNotify).toEqual([])
  })

  it('advances nextSinceTs to the max startedAt across ALL rows, including non-notify-worthy ones (manual runs / successes still move the polling window forward)', () => {
    const rows = [
      row({ result: 'success', startedAt: new Date(BASE + 1000) }),
      row({ triggeredBy: 'manual', result: 'failure', startedAt: new Date(BASE + 9000) }) // latest, but not notify-worthy
    ]
    const { toNotify, nextSinceTs } = selectNewFailures(rows, BASE)
    expect(toNotify).toEqual([])
    expect(nextSinceTs).toBe(BASE + 9000)
  })

  it('leaves the watermark unchanged when there are no rows', () => {
    expect(selectNewFailures([], BASE).nextSinceTs).toBe(BASE)
  })
})

describe('formatFailureNotification', () => {
  const f = (over: Partial<ScheduledFailure> = {}): ScheduledFailure =>
    row({ ...over }) as ScheduledFailure

  it('a single failure: title = job name, body = "failed · exit N · HH:MM"', () => {
    const { title, body } = formatFailureNotification([
      f({ jobName: 'Nightly Backup', result: 'failure', exitCode: 2, startedAt: new Date('2026-08-01T02:05:00') })
    ])
    expect(title).toBe('Nightly Backup')
    expect(body).toBe('failed · exit 2 · 02:05')
  })

  it('a single timeout: no exit code in the body (mirrors notify_format.go\'s formatImmediate)', () => {
    const { body } = formatFailureNotification([
      f({ result: 'timeout', exitCode: null, startedAt: new Date('2026-08-01T03:00:00') })
    ])
    expect(body).toBe('timed out · 03:00')
  })

  it('multiple failures in one tick: "N jobs failed" digest with a bullet per job (mirrors formatDigest)', () => {
    const { title, body } = formatFailureNotification([
      f({ jobName: 'Backup', result: 'failure', exitCode: 1, startedAt: new Date('2026-08-01T02:00:00') }),
      f({ jobName: 'Sync', result: 'timeout', exitCode: null, startedAt: new Date('2026-08-01T02:05:00') })
    ])
    expect(title).toBe('2 jobs failed')
    expect(body).toBe('• Backup — failure (exit 1) 02:00\n• Sync — timeout 02:05')
  })
})

function fakeNotifier(supported = true): NativeNotifier & { shown: Array<{ title: string; body: string; onClick: () => void }> } {
  const shown: Array<{ title: string; body: string; onClick: () => void }> = []
  return {
    isSupported: () => supported,
    show: (opts) => { shown.push(opts) },
    shown
  }
}

describe('createNativeNotifyService', () => {
  it('applyRunEvent no-ops on "started"/"output" (no listRunOutcomes call)', () => {
    const listRunOutcomes = vi.fn(async () => [])
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => true, notifier: fakeNotifier(), onOpen: vi.fn()
    })
    handle.applyRunEvent({ kind: 'started', jobId: 1, runId: 1, triggeredBy: 'manual', startedAt: 0 })
    handle.applyRunEvent({ kind: 'output', runId: 1, stream: 'stdout', chunk: 'x' })
    expect(listRunOutcomes).not.toHaveBeenCalled()
  })

  it('applyRunEvent triggers a check on "finished" and "jobsChanged" (awaited separately — back-to-back calls in the SAME tick instead coalesce, see the re-entrancy test below)', async () => {
    const listRunOutcomes = vi.fn(async () => [] as RunOutcomeRow[])
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => true, notifier: fakeNotifier(), onOpen: vi.fn(), now: () => new Date(BASE)
    })
    handle.applyRunEvent({ kind: 'finished', runId: 1, result: 'success', exitCode: 0, endedAt: 0 })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(listRunOutcomes).toHaveBeenCalledTimes(1)
    handle.applyRunEvent({ kind: 'jobsChanged' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(listRunOutcomes).toHaveBeenCalledTimes(2)
  })

  it('shows a notification for a newly-discovered scheduled failure, wired to onOpen on click', async () => {
    const failure = row({ jobId: 7, jobName: 'Backup', startedAt: new Date(BASE + 1000) })
    const listRunOutcomes = vi.fn(async () => [failure])
    const onOpen = vi.fn()
    const notifier = fakeNotifier()
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => true, notifier, onOpen, now: () => new Date(BASE)
    })
    handle.applyRunEvent({ kind: 'jobsChanged' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(notifier.shown).toHaveLength(1)
    expect(notifier.shown[0].title).toBe('Backup')
    notifier.shown[0].onClick()
    expect(onOpen).toHaveBeenCalled()
  })

  it('boot watermark: a failure that started BEFORE the service was created is never notified (no backlog blast on launch) — even if the query layer returned it anyway', async () => {
    const staleFailure = row({ startedAt: new Date(BASE - 5000) }) // "started" before construction
    // Deliberately ignores `since` (simulating an over-wide query) to prove the SERVICE's own
    // selectNewFailures watermark check — not just the repository's `gt` SQL bound — is what
    // actually guards against a backlog blast.
    const listRunOutcomes = vi.fn(async () => [staleFailure])
    const notifier = fakeNotifier()
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => true, notifier, onOpen: vi.fn(), now: () => new Date(BASE)
    })
    handle.applyRunEvent({ kind: 'jobsChanged' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(notifier.shown).toHaveLength(0)
  })

  it('respects the "Native failure notifications" toggle: no notification when disabled, but the watermark still advances (no replay burst when re-enabled)', async () => {
    const failure1 = row({ jobId: 1, startedAt: new Date(BASE + 1000) })
    const failure2 = row({ jobId: 2, startedAt: new Date(BASE + 2000) })
    let enabled = false
    const seenSinceArgs: number[] = []
    const listRunOutcomes = vi.fn(async (since: Date) => {
      seenSinceArgs.push(since.getTime())
      return since.getTime() < BASE + 1000 ? [failure1] : [failure2]
    })
    const notifier = fakeNotifier()
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => enabled, notifier, onOpen: vi.fn(), now: () => new Date(BASE)
    })
    handle.applyRunEvent({ kind: 'jobsChanged' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(notifier.shown).toHaveLength(0) // disabled — nothing shown
    enabled = true
    handle.applyRunEvent({ kind: 'jobsChanged' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    // Second tick's query used the ADVANCED watermark (past failure1), so only failure2 is fetched —
    // failure1 is never replayed as a burst now that the toggle is back on.
    expect(seenSinceArgs[1]).toBe(BASE + 1000)
    expect(notifier.shown).toHaveLength(1)
    expect(notifier.shown[0].title).toBe('Backup')
  })

  it('skips showing when Notification.isSupported() is false', async () => {
    const failure = row({ startedAt: new Date(BASE + 1000) })
    const listRunOutcomes = vi.fn(async () => [failure])
    const notifier = fakeNotifier(false)
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => true, notifier, onOpen: vi.fn(), now: () => new Date(BASE)
    })
    handle.applyRunEvent({ kind: 'jobsChanged' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(notifier.shown).toHaveLength(0)
  })

  it('re-entrant: overlapping applyRunEvent calls while a check is in-flight join it instead of firing a second query', async () => {
    let resolveFetch: (() => void) | undefined
    const listRunOutcomes = vi.fn(
      () => new Promise<RunOutcomeRow[]>((resolve) => { resolveFetch = () => resolve([]) })
    )
    const handle = createNativeNotifyService({
      listRunOutcomes, getNativeEnabled: async () => true, notifier: fakeNotifier(), onOpen: vi.fn(), now: () => new Date(BASE)
    })
    handle.applyRunEvent({ kind: 'jobsChanged' })
    handle.applyRunEvent({ kind: 'finished', runId: 1, result: 'success', exitCode: 0, endedAt: 0 })
    expect(listRunOutcomes).toHaveBeenCalledTimes(1) // second call joined the in-flight one
    resolveFetch?.()
    await Promise.resolve(); await Promise.resolve()
  })
})

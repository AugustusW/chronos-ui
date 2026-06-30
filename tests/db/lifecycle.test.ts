// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { openAndMigrate, startCheckpointTimer, startRetentionSweep } from '../../src/main/db/lifecycle'
import { listJobs } from '../../src/main/db/jobs.repository'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))
const PG_MIGRATIONS = fileURLToPath(new URL('../../src/main/db/migrations.pg', import.meta.url))

describe('openAndMigrate', () => {
  it('opens an in-memory sqlite DB and applies migrations so repositories work', async () => {
    const h = await openAndMigrate(
      { dialect: 'sqlite', path: ':memory:' },
      { sqlite: MIGRATIONS, pg: PG_MIGRATIONS }
    )
    expect(h.dialect).toBe('sqlite')
    expect(listJobs(h.db as never)).toEqual([]) // table exists because migrations ran
    await h.close()
  })
})

describe('startCheckpointTimer', () => {
  it('checkpoints on the interval and the stop fn clears it', () => {
    vi.useFakeTimers()
    const handle = { checkpoint: vi.fn() } as unknown as Parameters<typeof startCheckpointTimer>[0]
    const stop = startCheckpointTimer(handle, 1000)
    vi.advanceTimersByTime(2500)
    expect(handle.checkpoint).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(5000)
    expect(handle.checkpoint).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('startRetentionSweep (review #4)', () => {
  it('prunes immediately then on each interval; cutoff = now - days; stop fn clears it', () => {
    vi.useFakeTimers()
    const DAY = 24 * 60 * 60 * 1000
    const fixedNow = 1_700_000_000_000
    const cutoffs: number[] = []
    const prune = vi.fn(async (cutoff: Date) => { cutoffs.push(cutoff.getTime()); return 0 })
    const stop = startRetentionSweep(prune, { days: 90, intervalMs: 1000, now: () => fixedNow })
    expect(prune).toHaveBeenCalledTimes(1) // immediate sweep on start
    expect(cutoffs[0]).toBe(fixedNow - 90 * DAY)
    vi.advanceTimersByTime(2500)
    expect(prune).toHaveBeenCalledTimes(3) // + 2 interval sweeps
    stop()
    vi.advanceTimersByTime(5000)
    expect(prune).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('is best-effort: a rejected prune is routed to onError and never throws', async () => {
    const onError = vi.fn()
    const prune = vi.fn(async () => { throw new Error('db locked') })
    const stop = startRetentionSweep(prune, { intervalMs: 60_000_000, onError })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    stop()
  })
})

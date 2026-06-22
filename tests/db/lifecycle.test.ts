// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { openAndMigrate, startCheckpointTimer } from '../../src/main/db/lifecycle'
import { listJobs } from '../../src/main/db/jobs.repository'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))

describe('openAndMigrate', () => {
  it('opens an in-memory DB and applies migrations so repositories work', () => {
    const h = openAndMigrate(':memory:', MIGRATIONS)
    expect(listJobs(h.db)).toEqual([]) // table exists because migrations ran
    h.close()
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

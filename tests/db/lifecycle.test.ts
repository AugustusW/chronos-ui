// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { openAndMigrate, startCheckpointTimer } from '../../src/main/db/lifecycle'
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

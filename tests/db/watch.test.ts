// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchDbForChanges } from '../../src/main/db/watch'

describe('watchDbForChanges', () => {
  it('fires (debounced) on -wal change and the stop fn ends watching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-watch-'))
    const dbPath = join(dir, 'chronos.db')
    const wal = dbPath + '-wal'
    writeFileSync(wal, '') // create the wal so fs.watch attaches
    const onChange = vi.fn()
    const stop = watchDbForChanges(dbPath, onChange, { debounceMs: 20 })
    // Allow one event-loop tick for the kernel watcher to register (macOS kqueue/FSEvents
    // needs a tick before it can catch events; without this the first write is missed).
    await new Promise((r) => setTimeout(r, 10))
    writeFileSync(wal, 'x')
    await new Promise((r) => setTimeout(r, 60))
    expect(onChange).toHaveBeenCalledTimes(1) // debounced to one
    stop()
    writeFileSync(wal, 'y')
    await new Promise((r) => setTimeout(r, 60))
    expect(onChange).toHaveBeenCalledTimes(1) // no more after stop
  })
})

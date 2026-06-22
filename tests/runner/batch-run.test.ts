// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { createBatchRunner } from '../../src/main/runner/batch-run'

describe('createBatchRunner', () => {
  it('runs ids sequentially', async () => {
    const order: number[] = []
    const r = createBatchRunner(async (id) => { order.push(id) })
    await r.run([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
  })
  it('cancel() stops the queue without killing the in-flight run', async () => {
    const seen: number[] = []
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const r = createBatchRunner(async (id) => { seen.push(id); if (id === 1) await gate })
    const p = r.run([1, 2, 3])
    r.cancel()           // cancel while id 1 is in-flight
    release()            // id 1 completes
    await p
    expect(seen).toEqual([1]) // 2 and 3 never start
  })
})

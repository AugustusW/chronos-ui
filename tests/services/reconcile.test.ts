// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { reconcile } from '../../src/main/services/reconcile'
import type { ParsedJob } from '../../src/main/scheduler/types'
import type { Job } from '../../src/main/db/schema'

const job = (over: Partial<Job>): Job => ({
  id: 1, name: 'n', source: 'native_cron', platform: 'darwin', scheduleExpr: '0 3 * * *',
  command: '/b.sh', workingDir: null, env: null, enabled: true, adopted: false, timeoutSec: null,
  category: null, lastRunAt: null, lastResult: null, createdAt: new Date(), updatedAt: new Date(), ...over
})
const parsed = (over: Partial<ParsedJob>): ParsedJob => ({
  chronosId: 1, scheduleExpr: '0 3 * * *', scheduleExprFormat: 'cron', command: '/b.sh', adopted: false, enabled: true, ...over
})

describe('reconcile', () => {
  it('classifies a matching managed job as in_sync', () => {
    const r = reconcile([parsed({})], [job({})])
    expect(r.items).toEqual([expect.objectContaining({ status: 'in_sync' })])
  })
  it('flags schedule/command/enabled mismatch as drifted with the changed fields', () => {
    const r = reconcile([parsed({ scheduleExpr: '0 5 * * *', enabled: false })], [job({})])
    expect(r.items[0].status).toBe('drifted')
    expect(r.items[0].driftFields).toEqual(expect.arrayContaining(['scheduleExpr', 'enabled']))
  })
  it('marks an unmanaged native line (chronosId null)', () => {
    const r = reconcile([parsed({ chronosId: null })], [])
    expect(r.items[0].status).toBe('unmanaged')
  })
  it('marks a DB job whose native line vanished', () => {
    const r = reconcile([], [job({ id: 7 })])
    expect(r.items).toEqual([expect.objectContaining({ status: 'vanished' })])
  })
  it('marks a chronos-marked native line with no DB row as orphan_native', () => {
    const r = reconcile([parsed({ chronosId: 99 })], [])
    expect(r.items[0].status).toBe('orphan_native')
  })
  it('stamps generatedAt from the injected clock', () => {
    expect(reconcile([], [], () => 12345).generatedAt).toBe(12345)
  })
})

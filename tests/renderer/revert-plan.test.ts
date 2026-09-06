// SPDX-License-Identifier: Apache-2.0
// A revert that silently restores some fields and not others is worse than one that refuses: the
// user walks away believing the job is back to its old state. These tests pin down exactly which
// fields the current update contract can express, and force the rest to be reported.
import { describe, it, expect } from 'vitest'
import { revertPlan } from '../../src/renderer/src/lib/revert-plan'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rev = (changedFields: string[], before: any): any => ({
  id: 1, jobId: 1, changedAt: new Date(), source: 'edit', changedFields, before, after: {}
})

describe('revertPlan', () => {
  it('restores an ordinary field through the update path', () => {
    expect(revertPlan(rev(['command'], { command: '/usr/bin/old.sh' }))).toEqual({
      changes: { command: '/usr/bin/old.sh' },
      unsupported: []
    })
  })

  it('restores several fields at once', () => {
    const p = revertPlan(rev(['scheduleExpr', 'timeoutSec'], { scheduleExpr: '0 3 * * *', timeoutSec: 60 }))
    expect(p.changes).toEqual({ scheduleExpr: '0 3 * * *', timeoutSec: 60 })
    expect(p.unsupported).toEqual([])
  })

  it('routes enabled through enable/disable, not through update', () => {
    expect(revertPlan(rev(['enabled'], { enabled: false }))).toEqual({
      changes: {}, setEnabled: false, unsupported: []
    })
    expect(revertPlan(rev(['enabled'], { enabled: true })).setEnabled).toBe(true)
  })

  it('omits setEnabled entirely when the revision did not touch enabled', () => {
    expect('setEnabled' in revertPlan(rev(['command'], { command: 'x' }))).toBe(false)
  })

  it('reports a field it cannot clear rather than pretending it reverted', () => {
    // UpdateJobChanges types workingDir as `string?`, and an omitted key means "leave unchanged",
    // so there is no way to express "put this back to not set".
    const p = revertPlan(rev(['workingDir'], { workingDir: null }))
    expect(p.changes).toEqual({})
    expect(p.unsupported).toEqual(['workingDir'])
  })

  // A `!old` check instead of `old === null || old === undefined` passes every other test in this
  // file, and would silently report these as unrestorable. They are ordinary values.
  it('restores falsy-but-set values rather than calling them unsupported', () => {
    expect(revertPlan(rev(['notifyOnFailure'], { notifyOnFailure: false }))).toEqual({
      changes: { notifyOnFailure: false }, unsupported: []
    })
    expect(revertPlan(rev(['timeoutSec'], { timeoutSec: 0 }))).toEqual({
      changes: { timeoutSec: 0 }, unsupported: []
    })
    expect(revertPlan(rev(['category'], { category: '' }))).toEqual({
      changes: { category: '' }, unsupported: []
    })
  })

  it('reports adopted as unsupported — it is undone by adopt/un-adopt, not by an edit', () => {
    expect(revertPlan(rev(['adopted'], { adopted: false })).unsupported).toEqual(['adopted'])
  })

  it('still restores what it can while reporting what it cannot', () => {
    const p = revertPlan(rev(['command', 'workingDir'], { command: '/usr/bin/old.sh', workingDir: null }))
    expect(p.changes).toEqual({ command: '/usr/bin/old.sh' })
    expect(p.unsupported).toEqual(['workingDir'])
  })

  it('restores an env object by value', () => {
    const p = revertPlan(rev(['env'], { env: { A: '1' } }))
    expect(p.changes).toEqual({ env: { A: '1' } })
  })

  it('reports an unknown field instead of dropping it', () => {
    expect(revertPlan(rev(['somethingNew'], { somethingNew: 1 })).unsupported).toEqual(['somethingNew'])
  })
})

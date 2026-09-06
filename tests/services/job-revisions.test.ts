// SPDX-License-Identifier: Apache-2.0
// diffJobConfig is the gate in front of every revision write: if it is wrong, we either lose
// changes (false "nothing changed") or fill the history with rows for edits that never happened.
// The env cases matter most — it is the only tracked field that is an object, so identity/order
// comparison silently produces phantom revisions on every save.
import { describe, it, expect } from 'vitest'
import { diffJobConfig, REVISION_TRACKED_FIELDS } from '../../src/main/services/job-revisions'

const base = {
  name: 'Nightly backup',
  scheduleExpr: '0 3 * * *',
  command: '/usr/bin/backup.sh',
  workingDir: null,
  env: null,
  timeoutSec: null,
  category: null,
  notifyOnFailure: false,
  enabled: true,
  adopted: false
}

describe('diffJobConfig', () => {
  it('returns null when nothing tracked changed', () => {
    expect(diffJobConfig(base, { ...base })).toBeNull()
  })

  it('ignores untracked fields (a run finishing must not look like an edit)', () => {
    const after = { ...base, lastRunAt: new Date(), lastResult: 'success' as const, updatedAt: new Date() }
    expect(diffJobConfig(base, after)).toBeNull()
  })

  it('reports a single scalar change with both sides', () => {
    const d = diffJobConfig(base, { ...base, command: '/usr/bin/backup2.sh' })
    expect(d).toEqual({
      changedFields: ['command'],
      before: { command: '/usr/bin/backup.sh' },
      after: { command: '/usr/bin/backup2.sh' }
    })
  })

  it('reports several changes, in the tracked-field order', () => {
    const d = diffJobConfig(base, { ...base, enabled: false, scheduleExpr: '*/5 * * * *' })
    expect(d?.changedFields).toEqual(['scheduleExpr', 'enabled'])
    expect(d?.before).toEqual({ scheduleExpr: '0 3 * * *', enabled: true })
    expect(d?.after).toEqual({ scheduleExpr: '*/5 * * * *', enabled: false })
  })

  it('treats null → value and value → null as changes', () => {
    expect(diffJobConfig(base, { ...base, timeoutSec: 30 })?.changedFields).toEqual(['timeoutSec'])
    expect(diffJobConfig({ ...base, timeoutSec: 30 }, base)?.changedFields).toEqual(['timeoutSec'])
  })

  it('compares env by content, not identity or key order', () => {
    const a = { ...base, env: { A: '1', B: '2' } }
    const b = { ...base, env: { B: '2', A: '1' } }
    expect(diffJobConfig(a, b)).toBeNull()
  })

  it('detects a real env change', () => {
    const a = { ...base, env: { A: '1' } }
    const b = { ...base, env: { A: '2' } }
    expect(diffJobConfig(a, b)?.changedFields).toEqual(['env'])
  })

  it('detects an env key being added or removed', () => {
    const a = { ...base, env: { A: '1' } }
    const b = { ...base, env: { A: '1', B: '2' } }
    expect(diffJobConfig(a, b)?.changedFields).toEqual(['env'])
    expect(diffJobConfig(b, a)?.changedFields).toEqual(['env'])
  })

  it('treats null env and empty-object env as different (one is unset, the other is set-but-empty)', () => {
    const a = { ...base, env: null }
    const b = { ...base, env: {} }
    expect(diffJobConfig(a, b)?.changedFields).toEqual(['env'])
  })

  it('tracks exactly the config fields — adding one to the schema must be a deliberate choice', () => {
    expect([...REVISION_TRACKED_FIELDS]).toEqual([
      'name',
      'scheduleExpr',
      'command',
      'workingDir',
      'env',
      'timeoutSec',
      'category',
      'notifyOnFailure',
      'enabled',
      'adopted'
    ])
  })
})

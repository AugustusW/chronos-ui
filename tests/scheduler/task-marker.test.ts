// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildDescription, parseDescription } from '../../src/main/scheduler/task-marker'

describe('task Description marker', () => {
  it('builds a stamped multi-line Description and round-trips it', () => {
    const d = buildDescription(42, 'daily 03:00')
    expect(d).toContain('chronos:42')
    expect(d).toContain('sched:daily 03:00')
    expect(parseDescription(d)).toEqual({ chronosId: 42, scheduleDescriptor: 'daily 03:00' })
  })

  it('returns null for an unmanaged (non-ChronosUI) Description', () => {
    expect(parseDescription('Some user task')).toBeNull()
    expect(parseDescription(null)).toBeNull()
    expect(parseDescription('')).toBeNull()
  })
})

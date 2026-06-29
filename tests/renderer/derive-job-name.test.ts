// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { deriveJobName } from '../../src/renderer/src/lib/format'

describe('deriveJobName', () => {
  it('extracts basename from first token with path', () => {
    expect(deriveJobName('/usr/bin/pg_dump assistant | gzip')).toBe('pg_dump')
  })

  it('uses first token when it has no path separator', () => {
    expect(deriveJobName('python3 /opt/jobs/reindex.py')).toBe('python3')
  })

  it('falls back to "job" for empty string', () => {
    expect(deriveJobName('')).toBe('job')
  })

  it('falls back to "job" for whitespace-only string', () => {
    expect(deriveJobName('   ')).toBe('job')
  })

  it('handles a bare command with no args', () => {
    expect(deriveJobName('/usr/local/bin/backup')).toBe('backup')
  })

  it('uses first token when command has no path', () => {
    expect(deriveJobName('echo hello world')).toBe('echo')
  })
})

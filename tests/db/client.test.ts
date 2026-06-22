// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../../src/main/db/client'

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('createDatabase', () => {
  it('enables WAL and the safety pragmas on a file-backed db', () => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-db-'))
    const { sqlite, close } = createDatabase(join(dir, 'chronos.db'))
    expect(String(sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(Number(sqlite.pragma('busy_timeout', { simple: true }))).toBe(5000)
    expect(Number(sqlite.pragma('foreign_keys', { simple: true }))).toBe(1)
    expect(Number(sqlite.pragma('journal_size_limit', { simple: true }))).toBe(6291456)
    close()
  })

  it('runs a passive checkpoint without throwing and closes cleanly', () => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-db-'))
    const handle = createDatabase(join(dir, 'chronos.db'))
    expect(() => handle.checkpoint()).not.toThrow()
    expect(() => handle.close()).not.toThrow()
  })
})

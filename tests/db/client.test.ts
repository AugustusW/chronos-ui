// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase, pgPoolOptions } from '../../src/main/db/client'

describe('pgPoolOptions (TLS — review #11)', () => {
  it('requires TLS for a non-local host', () => {
    expect(pgPoolOptions('postgres://u:pw@db.example.com:5432/app')).toEqual({
      connectionString: 'postgres://u:pw@db.example.com:5432/app',
      ssl: { rejectUnauthorized: true }
    })
  })
  it('stays plaintext for a local host', () => {
    for (const dsn of ['postgres://localhost/app', 'postgres://127.0.0.1:5432/app', 'postgres://u@[::1]/app']) {
      expect(pgPoolOptions(dsn).ssl, dsn).toBeUndefined()
    }
  })
  it('defers to an explicit sslmode in the DSN (does not override)', () => {
    expect(pgPoolOptions('postgres://db.example.com/app?sslmode=require').ssl).toBeUndefined()
  })
})

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('createDatabase', () => {
  it('enables WAL and the safety pragmas on a file-backed db', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-db-'))
    const { sqlite, close } = createDatabase(join(dir, 'chronos.db'))
    expect(sqlite).toBeDefined()
    expect(String(sqlite!.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
    expect(Number(sqlite!.pragma('busy_timeout', { simple: true }))).toBe(5000)
    expect(Number(sqlite!.pragma('foreign_keys', { simple: true }))).toBe(1)
    expect(Number(sqlite!.pragma('journal_size_limit', { simple: true }))).toBe(6291456)
    await close()
  })

  it('runs a passive checkpoint without throwing and closes cleanly', async () => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-db-'))
    const handle = createDatabase(join(dir, 'chronos.db'))
    expect(() => handle.checkpoint()).not.toThrow()
    await expect(handle.close()).resolves.toBeUndefined()
  })
})

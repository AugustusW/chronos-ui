// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  sanitizeService,
  pgSecretFallbackPath,
  pgSecretStore,
  pgSecretRead,
  pgSecretDelete,
  type PgSecretDeps
} from '../../src/main/services/pg-secret'

describe('sanitizeService', () => {
  it('parity with schedmgr/secret_test.go TestSanitizeService', () => {
    // Go: sanitizeService("com.augustusw.chronos-ui/pg-dsn") == "com.augustusw.chronos-ui_pg-dsn"
    expect(sanitizeService('com.augustusw.chronos-ui/pg-dsn')).toBe('com.augustusw.chronos-ui_pg-dsn')
  })

  it('replaces colon', () => {
    expect(sanitizeService('pg:keychain:main')).toBe('pg_keychain_main')
  })

  it('replaces multiple slashes and colons together', () => {
    expect(sanitizeService('a/b:c/d')).toBe('a_b_c_d')
  })
})

describe('pgSecretFallbackPath', () => {
  it('builds <configDir>/<sanitized>.dsn (configDir is already the chronos-ui dir, e.g. goSecretDir output)', () => {
    // join() is host-native (mirrors Go's filepath.Join in the same binary), so build the
    // expectation with join too — the assertion is about the sanitized FILENAME, not the separator.
    const configDir = join('/Users', 'x', 'Library', 'Application Support', 'chronos-ui')
    expect(pgSecretFallbackPath(configDir, 'com.augustusw.chronos-ui/pg-dsn')).toBe(
      join(configDir, 'com.augustusw.chronos-ui_pg-dsn.dsn')
    )
  })
})

describe('pgSecretStore / pgSecretRead / pgSecretDelete', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chronos-pg-secret-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const deps = (over: Partial<PgSecretDeps> = {}): PgSecretDeps => ({
    exec: vi.fn(async () => ({ code: 1, stdout: '' })),
    platform: 'win32',
    configDir: dir,
    ...over
  })

  it('writes the keychain item on darwin AND the fallback file — the reader is cron, not this session', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }))
    const d = deps({ exec, platform: 'darwin' })
    await pgSecretStore('svc-a', 'postgresql://u:p@h/db', d)
    expect(exec).toHaveBeenCalledWith(
      'security',
      ['add-generic-password', '-U', '-s', 'svc-a', '-a', 'chronos-ui', '-w', 'postgresql://u:p@h/db'],
      undefined
    )
    // This assertion used to be toBe(false): a successful keychain write returned early and the
    // fallback file was never created. That is correct only if whoever reads the secret shares this
    // process's keychain access — and schedmgr does not. It runs from cron, outside the GUI security
    // session, where `security` exits 44 on an item this session reads fine. Measured on a real
    // machine 2026-09-05: seven weeks of run_logs silently lost to exactly this.
    const path = pgSecretFallbackPath(dir, 'svc-a')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('postgresql://u:p@h/db')
  })

  it('keeps the fallback file 0600 on the keychain-success path too', async () => {
    // The keychain path is the one that now also touches disk, so it needs its own mode check —
    // the pre-existing 0600 test only covers the win32 (no-keychain) branch.
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }))
    await pgSecretStore('svc-a2', 'dsn', deps({ exec, platform: 'darwin' }))
    if (process.platform !== 'win32') {
      expect(statSync(pgSecretFallbackPath(dir, 'svc-a2')).mode & 0o777).toBe(0o600)
    }
  })

  it('falls back to the 0600 file when the platform has no keychain (win32), without invoking exec', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }))
    const d = deps({ exec, platform: 'win32' })
    await pgSecretStore('svc-b', 'postgresql://u:p@h/db', d)
    expect(exec).not.toHaveBeenCalled()
    const path = pgSecretFallbackPath(dir, 'svc-b')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('postgresql://u:p@h/db')
  })

  it('falls back to the 0600 file when the keychain write fails (exec exits non-zero)', async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: 'denied' }))
    const d = deps({ exec, platform: 'darwin' })
    await pgSecretStore('svc-c', 'postgresql://u:p@h/db', d)
    const path = pgSecretFallbackPath(dir, 'svc-c')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('postgresql://u:p@h/db')
  })

  it('fallback file is written 0600', async () => {
    const d = deps({ platform: 'win32' })
    await pgSecretStore('svc-d', 'dsn', d)
    const mode = statSync(pgSecretFallbackPath(dir, 'svc-d')).mode & 0o777
    // POSIX hosts honor the 0600 request; Windows has no POSIX mode bits (Node maps chmod onto
    // the read-only attribute), so only assert the exact mode where the OS can express it.
    if (process.platform === 'win32') {
      expect(existsSync(pgSecretFallbackPath(dir, 'svc-d'))).toBe(true)
    } else {
      expect(mode).toBe(0o600)
    }
  })

  it('store -> read roundtrips through the fallback file (win32, no keychain)', async () => {
    const d = deps({ platform: 'win32' })
    await pgSecretStore('svc-e', 'postgresql://roundtrip', d)
    expect(await pgSecretRead('svc-e', d)).toBe('postgresql://roundtrip')
  })

  it('store -> read roundtrips through the keychain (mock execFn echoes back what was stored)', async () => {
    let stored = ''
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'add-generic-password') {
        stored = args[args.length - 1]
        return { code: 0, stdout: '' }
      }
      if (args[0] === 'find-generic-password') return { code: 0, stdout: stored }
      return { code: 1, stdout: '' }
    })
    const d = deps({ exec, platform: 'darwin' })
    await pgSecretStore('svc-f', 'postgresql://from-keychain', d)
    expect(await pgSecretRead('svc-f', d)).toBe('postgresql://from-keychain')
  })

  it('read returns null when neither the keychain nor the fallback file has the service', async () => {
    const d = deps({ platform: 'win32' })
    expect(await pgSecretRead('svc-missing', d)).toBeNull()
  })

  it('delete removes the keychain item (mock execFn) and the fallback file', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }))
    const d = deps({ exec, platform: 'darwin' })
    writeFileSync(pgSecretFallbackPath(dir, 'svc-g'), 'stale', { mode: 0o600 })
    await pgSecretDelete('svc-g', d)
    expect(exec).toHaveBeenCalledWith('security', ['delete-generic-password', '-s', 'svc-g'])
    expect(existsSync(pgSecretFallbackPath(dir, 'svc-g'))).toBe(false)
  })

  it('delete is a no-op (never throws) when nothing exists', async () => {
    const d = deps({ platform: 'win32' })
    await expect(pgSecretDelete('svc-h', d)).resolves.toBeUndefined()
  })
})

// SPDX-License-Identifier: Apache-2.0
//
// Real-Postgres integration suite for backend-switch.ts (T5-T10). Gated on TEST_PG_URL exactly like
// tests/db/repositories.test.ts (CI's dedicated `test-pg` ubuntu job sets it; local runs can start a
// throwaway `docker run --rm -d -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16` and export
// TEST_PG_URL=postgres://postgres:test@localhost:55432/postgres).
//
// Isolation: repositories.test.ts's postgres backend runs its DDL/DML directly against TEST_PG_URL's
// own database (`postgres` in CI) and — being test-file-parallel under vitest — could interleave with
// anything else hitting that same database's `public`/`drizzle` schemas. Every test here instead
// bootstraps its OWN throwaway Postgres DATABASE (via a maintenance connection to TEST_PG_URL) per
// `describe` block and drops it afterwards, so this suite can never race repositories.test.ts (or a
// future pg-touching suite) regardless of vitest's file-level parallelism.
import { describe, it, expect } from 'vitest'
import { Client } from 'pg'
import { testConnection } from '../../src/main/services/backend-switch'

const maybeDescribe = process.env.TEST_PG_URL ? describe : describe.skip

/** Bootstraps (CREATE DATABASE) + tears down (DROP DATABASE) a throwaway Postgres database off the
 *  TEST_PG_URL maintenance connection, and returns a DSN pointed at it. */
async function withFreshDatabase<T>(name: string, fn: (dsn: string) => Promise<T>): Promise<T> {
  const base = new URL(process.env.TEST_PG_URL!)
  const admin = new Client({ connectionString: process.env.TEST_PG_URL })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end()
  }
  const dsn = new URL(base.toString())
  dsn.pathname = `/${name}`
  try {
    return await fn(dsn.toString())
  } finally {
    const admin2 = new Client({ connectionString: process.env.TEST_PG_URL })
    await admin2.connect()
    try {
      // Terminate any lingering backends (a leaked pool/connection would make DROP DATABASE hang).
      await admin2.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      )
      await admin2.query(`DROP DATABASE IF EXISTS ${name}`)
    } finally {
      await admin2.end()
    }
  }
}

maybeDescribe('backend-switch.ts (real Postgres, TEST_PG_URL)', () => {
  describe('testConnection', () => {
    it('connects to a real database and returns a version string', async () => {
      await withFreshDatabase('chronos_bswitch_t5', async (dsn) => {
        const res = await testConnection(dsn)
        expect(res.ok).toBe(true)
        if (res.ok) {
          expect(res.version).toContain('PostgreSQL')
          expect(res.ms).toBeGreaterThanOrEqual(0)
        }
      })
    })

    it('returns ok:false with a redacted error for a database that does not exist', async () => {
      const base = new URL(process.env.TEST_PG_URL!)
      base.pathname = '/chronos_bswitch_does_not_exist'
      base.username = 'postgres'
      base.password = 'wrong-password-xyz'
      const res = await testConnection(base.toString())
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).not.toContain('wrong-password-xyz')
    })
  })
})

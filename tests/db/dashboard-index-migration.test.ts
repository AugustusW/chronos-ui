// SPDX-License-Identifier: Apache-2.0
// Final review #5 (Task 1 deferred minor): locks in that the dashboard's `(startedAt, result)`
// composite index (architect HIGH-2 — supports the "today's failures" query, run_logs can reach
// ~130k rows under the 90-day retention window) actually shipped in the 0004 migration, for both
// dialects. Same regex-on-sql pattern as migrations-pg.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SQLITE_DIR = join(__dirname, '../../src/main/db/migrations')
const PG_DIR = join(__dirname, '../../src/main/db/migrations.pg')

function readAllSql(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

describe('run_logs_startedAt_result_idx exists in both dialects', () => {
  it('sqlite migrations create the index', () => {
    expect(readAllSql(SQLITE_DIR)).toMatch(/CREATE INDEX.*run_logs_startedAt_result_idx.*ON.*run_logs.*\(.*startedAt.*result.*\)/s)
  })

  it('postgres migrations create the index', () => {
    expect(readAllSql(PG_DIR)).toMatch(/CREATE INDEX.*run_logs_startedAt_result_idx.*ON.*run_logs.*\(.*startedAt.*result.*\)/s)
  })
})

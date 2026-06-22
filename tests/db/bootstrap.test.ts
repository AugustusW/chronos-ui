// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'

function tableColumns(sqlite: import('better-sqlite3').Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name)
}

describe('db bootstrap', () => {
  it('creates jobs and run_logs tables via migrations', () => {
    const { sqlite, close } = createDatabase(':memory:')
    runMigrations(sqlite)
    const tables = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(tables).toContain('jobs')
    expect(tables).toContain('run_logs')

    const jobCols = tableColumns(sqlite, 'jobs')
    for (const c of ['id', 'name', 'source', 'platform', 'scheduleExpr', 'command', 'enabled', 'adopted', 'createdAt', 'updatedAt']) {
      expect(jobCols, `jobs.${c}`).toContain(c)
    }
    const runCols = tableColumns(sqlite, 'run_logs')
    for (const c of ['id', 'jobId', 'triggeredBy', 'result', 'startedAt', 'endedAt', 'durationMs', 'exitCode', 'stdout', 'stderr', 'createdAt']) {
      expect(runCols, `run_logs.${c}`).toContain(c)
    }
    close()
  })
})

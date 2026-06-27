// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '../../src/main/db/migrations.pg')

describe('postgres migrations', () => {
  it('has a generated migration creating both tables', () => {
    const sqlFiles = readdirSync(DIR).filter((f) => f.endsWith('.sql'))
    expect(sqlFiles.length).toBeGreaterThanOrEqual(1)
    const sql = sqlFiles.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n')
    expect(sql).toMatch(/CREATE TABLE (?:IF NOT EXISTS )?"jobs"/)
    expect(sql).toMatch(/CREATE TABLE (?:IF NOT EXISTS )?"run_logs"/)
    expect(sql).toMatch(/"id" serial PRIMARY KEY/)
    expect(sql).toMatch(/REFERENCES\s+(?:"public"\.)?"jobs"/)
  })
})

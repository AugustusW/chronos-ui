// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import * as sqliteSchema from '../../src/main/db/schema'
import * as pgSchema from '../../src/main/db/schema.pg'

// The two Drizzle schemas (sqlite + pg) must never silently diverge: same tables, same column
// keys, same SQL column names, same notNull. Types differ by dialect and are intentionally not
// compared here (that is the dialect mapping's job).
const TABLES = ['jobs', 'runLogs'] as const

describe('schema parity (sqlite vs pg)', () => {
  for (const key of TABLES) {
    it(`${key}: same SQL table name`, () => {
      expect(getTableName(pgSchema[key])).toBe(getTableName(sqliteSchema[key]))
    })

    it(`${key}: same column set, names, notNull and logical dataType`, () => {
      const s = getTableColumns(sqliteSchema[key])
      const p = getTableColumns(pgSchema[key])
      expect(Object.keys(p).sort()).toEqual(Object.keys(s).sort())
      for (const col of Object.keys(s)) {
        expect(p[col].name, `${key}.${col} SQL name`).toBe(s[col].name)
        expect(p[col].notNull, `${key}.${col} notNull`).toBe(s[col].notNull)
        // Drizzle's `dataType` is the dialect-agnostic logical kind ('number' | 'string' | 'boolean'
        // | 'date' | 'json'). The pg repos cast the sqlite-typed NewJob into the pg insert type, so
        // this is the ONLY guard that a sqlite int/text/json column maps to the SAME logical kind on
        // pg (e.g. catches a json→text or date→number drift the casts would otherwise hide).
        expect(p[col].dataType, `${key}.${col} dataType`).toBe(s[col].dataType)
      }
    })
  }
})

// SPDX-License-Identifier: Apache-2.0
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { createDatabase, type DatabaseHandle, type SqliteDb } from '../../src/main/db/client'

const MIGRATIONS = fileURLToPath(new URL('../../src/main/db/migrations', import.meta.url))

/** Fresh in-memory sqlite database with migrations applied, for repository tests (synchronous —
 *  the better-sqlite3 migrator is sync, so this avoids the async dialect-aware openAndMigrate). */
export function makeTestDb(): DatabaseHandle {
  const handle = createDatabase({ dialect: 'sqlite', path: ':memory:' })
  migrate(handle.db as SqliteDb, { migrationsFolder: MIGRATIONS })
  return handle
}

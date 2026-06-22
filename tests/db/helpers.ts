// SPDX-License-Identifier: Apache-2.0
import { createDatabase, type DatabaseHandle } from '../../src/main/db/client'
import { runMigrations } from '../../src/main/db/migrate'

/** Fresh in-memory database with migrations applied, for repository tests. */
export function makeTestDb(): DatabaseHandle {
  const handle = createDatabase(':memory:')
  runMigrations(handle.sqlite)
  return handle
}

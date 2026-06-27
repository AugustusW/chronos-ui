// SPDX-License-Identifier: Apache-2.0
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import type { DatabaseHandle, SqliteDb, PgDb } from './client'

/**
 * Apply pending migrations for the handle's dialect. SQLite uses the better-sqlite3 migrator
 * (synchronous); PostgreSQL uses the node-postgres migrator (async). `paths` carries both
 * per-dialect migration folders (resolveMigrationsPaths); only the active dialect's set runs.
 *
 * The folders are bundled into out/main/{migrations,migrations.pg} by electron-vite and, in a
 * packaged build, shipped via electron-builder `asarUnpack` + resolved from process.resourcesPath
 * (see resolveMigrationsPaths in paths.ts).
 */
export async function runMigrations(
  handle: DatabaseHandle,
  paths: { sqlite: string; pg: string }
): Promise<void> {
  if (handle.dialect === 'postgres') {
    await migratePg(handle.db as PgDb, { migrationsFolder: paths.pg })
    return
  }
  migrateSqlite(handle.db as SqliteDb, { migrationsFolder: paths.sqlite })
}

// SPDX-License-Identifier: Apache-2.0
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'

// Migrations live next to this module. For dev + tests, resolve relative to the source file.
// ⚠️ Plan 5/7 MUST REPLACE this default (not merely add an import): once electron-vite bundles
// the main process, and especially inside a packaged `.asar`, `import.meta.url` no longer points
// at a real migrations/ dir. The folder must be shipped via electron-builder `asarUnpack` and
// resolved from `process.resourcesPath` (e.g. join(process.resourcesPath, 'app.asar.unpacked',
// 'out/main/migrations')). Tracked as a Plan 5/7 task.
const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * Apply all pending migrations. Accepts a raw better-sqlite3 handle. `migrationsFolder` is
 * injectable for tests.
 */
export function runMigrations(
  sqlite: Database.Database,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER
): void {
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
}

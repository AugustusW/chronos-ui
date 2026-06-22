// SPDX-License-Identifier: Apache-2.0
import { createDatabase, type DatabaseHandle } from './client'
import { runMigrations } from './migrate'

/** Open the DB and bring its schema up to date (Drizzle migrate is idempotent — architect Q5). */
export function openAndMigrate(dbPath: string, migrationsPath: string): DatabaseHandle {
  const handle = createDatabase(dbPath)
  runMigrations(handle.sqlite, migrationsPath)
  return handle
}

/** Periodic passive WAL checkpoint while the GUI is open (spec §7). Returns a stop fn. */
export function startCheckpointTimer(
  handle: Pick<DatabaseHandle, 'checkpoint'>,
  intervalMs = 60_000
): () => void {
  const timer = setInterval(() => handle.checkpoint(), intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return () => clearInterval(timer)
}

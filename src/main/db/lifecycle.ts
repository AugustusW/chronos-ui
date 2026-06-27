// SPDX-License-Identifier: Apache-2.0
import { createDatabase, type BackendConfig, type DatabaseHandle } from './client'
import { runMigrations } from './migrate'

/**
 * Open the DB for the given backend and bring its schema up to date (Drizzle migrate is
 * idempotent — architect Q5). `paths` provides both per-dialect migration folders; the active
 * dialect's set is applied. Async because the PostgreSQL migrator is async.
 */
export async function openAndMigrate(
  config: BackendConfig,
  paths: { sqlite: string; pg: string }
): Promise<DatabaseHandle> {
  const handle = createDatabase(config)
  await runMigrations(handle, paths)
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

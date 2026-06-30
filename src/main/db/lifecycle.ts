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

/** Default run-history retention: drop runs older than 90 days. */
export const RUN_LOG_RETENTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Periodically prune run_logs older than `days` to bound the otherwise insert-only history. Sweeps
 * once immediately (so an app that is rarely left open still trims on launch) and then daily while the
 * GUI is open. Best-effort: a failed sweep is reported via onError and never throws. `now` is injected
 * for tests. Returns a stop fn. (review #4)
 */
export function startRetentionSweep(
  pruneOlderThan: (cutoff: Date) => Promise<number>,
  opts: { days?: number; intervalMs?: number; onError?: (e: unknown) => void; now?: () => number } = {}
): () => void {
  const days = opts.days ?? RUN_LOG_RETENTION_DAYS
  const intervalMs = opts.intervalMs ?? DAY_MS
  const now = opts.now ?? Date.now
  // No concurrent-run guard: the daily interval dwarfs any realistic prune duration, the sqlite path
  // is synchronous (can't overlap), and an overlapping age-based DELETE is idempotent anyway.
  const sweep = (): void => {
    const cutoff = new Date(now() - days * DAY_MS)
    void pruneOlderThan(cutoff).catch((e) => opts.onError?.(e))
  }
  sweep()
  const timer = setInterval(sweep, intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  return () => clearInterval(timer)
}

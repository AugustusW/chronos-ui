// SPDX-License-Identifier: Apache-2.0
import { createDatabase, type BackendConfig, type DatabaseHandle } from './client'
import { runMigrations } from './migrate'

/** The actual drain: await `handle.close()`, logging (never throwing) on failure. Shared by
 *  pgQuitDrain below (which additionally re-invokes `app.quit()` once this settles, for the
 *  `before-quit` path) and bootstrap.ts's `IpcDeps.drainDb` (C2, code review): `app.exit()` — unlike
 *  `app.quit()` — never fires `before-quit`, so ipc.ts's handlePgSaveSwitch (which calls
 *  `relaunchApp()`/`exitApp()` after a successful backend switch) must await this DIRECTLY before
 *  exiting, or a live postgres pool is never drained on that path at all. */
export async function drainPgHandle(handle: Pick<DatabaseHandle, 'close'>): Promise<void> {
  try {
    await handle.close()
  } catch (err) {
    console.error('chronos: postgres pool drain failed (continuing anyway):', err)
  }
}

/** T12: the `before-quit` handling a possibly-postgres DatabaseHandle needs. SQLite's close() is
 *  synchronous internally (a fire-and-forget close from the caller is safe — nothing async races
 *  the process exit), but Postgres's pool.end() is a real async drain: cutting the process before
 *  it settles could abort an in-flight write. Returns null for a sqlite handle (or no handle at
 *  all — e.g. before boot finishes), so the caller keeps its existing fire-and-forget close(); for
 *  postgres it returns a function the caller must run AFTER calling `event.preventDefault()`, which
 *  itself calls `app.quit()` again once the drain settles (Electron's before-quit is
 *  edge-triggered: calling preventDefault() cancels the ENTIRE quit sequence until something
 *  re-requests it). A failed drain (drainPgHandle) is logged but never blocks quitting —
 *  app.quit() runs regardless of whether close() resolved or rejected. */
export function pgQuitDrain(
  handle: Pick<DatabaseHandle, 'dialect' | 'close'> | null,
  app: { quit(): void }
): (() => Promise<void>) | null {
  if (!handle || handle.dialect !== 'postgres') return null
  return async () => {
    await drainPgHandle(handle)
    app.quit()
  }
}

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

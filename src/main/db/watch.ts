// SPDX-License-Identifier: Apache-2.0
import { watch, type FSWatcher } from 'node:fs'

/**
 * Watch the SQLite WAL file for changes (architect MEDIUM-1): in WAL mode the separate schedmgr
 * process writes the `-wal` file; the main db only changes at checkpoint. ENOENT-graceful (the wal
 * may not exist before the first write) + debounced. Returns a stop fn.
 */
export function watchDbForChanges(
  dbPath: string,
  onChange: () => void,
  opts: { debounceMs?: number } = {}
): () => void {
  const debounceMs = opts.debounceMs ?? 300
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }
  try {
    watcher = watch(dbPath + '-wal', fire)
  } catch {
    watcher = null // ENOENT etc. — caller's periodic poll is the fallback
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}

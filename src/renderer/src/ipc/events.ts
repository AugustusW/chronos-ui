// SPDX-License-Identifier: Apache-2.0
import type { RunEvent } from '../../../shared/ipc-contract'

interface RunEventSink { applyRunEvent(e: RunEvent): void }

/**
 * Subscribe to run events ONCE for the app's lifetime (architect HIGH-2) and dispatch into the
 * store. Components never call onRunEvent directly. Returns the unsubscribe.
 */
export function startRunEventBridge(store: RunEventSink): () => void {
  return window.chronos.onRunEvent((e) => store.applyRunEvent(e))
}

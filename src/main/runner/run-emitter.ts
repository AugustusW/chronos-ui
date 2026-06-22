// SPDX-License-Identifier: Apache-2.0
import { IPC, type RunEvent } from '../../shared/ipc-contract'

/** Minimal slice of Electron WebContents — keeps this unit testable without electron. */
export interface WebContentsLike {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * Build a guarded emitter (architect HIGH-1): every send checks the window still exists, so closing
 * the window mid-run cannot crash the main process with "Object has been destroyed".
 */
export function makeRunEmitter(getWebContents: () => WebContentsLike | undefined): (e: RunEvent) => void {
  return (e) => {
    const wc = getWebContents()
    if (!wc || wc.isDestroyed()) return
    wc.send(IPC.runEvent, e)
  }
}

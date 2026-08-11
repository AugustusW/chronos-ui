// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { handleNotifySave, type IpcDeps } from '../../src/main/ipc'

const depsWith = (notify: Partial<IpcDeps['notify']>) => ({ notify } as unknown as IpcDeps)

describe('notify IPC handlers', () => {
  it('rejects bad windowMin', async () => {
    const r = await handleNotifySave(depsWith({}), { enabled: true, chatId: '1', windowMin: -3 })
    expect(r.ok).toBe(false)
  })
  it('forwards a valid payload to the service', async () => {
    const save = vi.fn(async () => ({ ok: true }))
    const r = await handleNotifySave(depsWith({ saveSettings: save }), { enabled: true, chatId: '1', windowMin: 5, token: '123:ABC' })
    expect(r.ok).toBe(true)
    expect(save).toHaveBeenCalledWith({ enabled: true, chatId: '1', windowMin: 5, token: '123:ABC' })
  })

  // v0.4.0: nativeEnabled — optional at the boundary (like includeStderr), but must be a boolean when present
  it('accepts a valid payload with nativeEnabled and forwards it as-is', async () => {
    const save = vi.fn(async () => ({ ok: true }))
    const r = await handleNotifySave(depsWith({ saveSettings: save }), { enabled: true, chatId: '1', windowMin: 5, nativeEnabled: false })
    expect(r.ok).toBe(true)
    expect(save).toHaveBeenCalledWith({ enabled: true, chatId: '1', windowMin: 5, nativeEnabled: false })
  })

  it('rejects a non-boolean nativeEnabled', async () => {
    const r = await handleNotifySave(depsWith({}), { enabled: true, chatId: '1', windowMin: 5, nativeEnabled: 'yes' })
    expect(r.ok).toBe(false)
  })
})

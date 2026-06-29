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
})

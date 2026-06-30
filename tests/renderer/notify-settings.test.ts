// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetNotifySingleton } from '../../src/renderer/src/stores/notify.store'
import SettingsView from '../../src/renderer/src/views/SettingsView.vue'

type GlobalWithWindow = typeof globalThis & { window: Record<string, unknown> }

beforeEach(() => {
  _resetNotifySingleton()
  // Augment the existing jsdom window so DOM event constructors remain intact
  const g = globalThis as GlobalWithWindow
  g.window ??= {} as Record<string, unknown>
  g.window.chronos = {
    platform: 'darwin',
    getNotifySettings: vi.fn(async () => ({ enabled: false, chatId: null, windowMin: 0, tokenSet: false })),
    saveNotifySettings: vi.fn(async () => ({ ok: true, settings: { enabled: true, chatId: '42', windowMin: 0, tokenSet: true } })),
    testNotify: vi.fn(async () => ({ ok: true }))
  }
})

describe('SettingsView notifications', () => {
  it('renders a Telegram notifications section', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    expect(w.text()).toContain('Telegram')
  })
  it('saving forwards token + chatId + window to the bridge', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="notify-enable"]').setValue(true)
    await w.find('[data-test="notify-token"]').setValue('BOT:1')
    await w.find('[data-test="notify-chat"]').setValue('42')
    await w.find('[data-test="notify-save"]').trigger('click')
    await flushPromises()
    expect(window.chronos.saveNotifySettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, chatId: '42', windowMin: 0, token: 'BOT:1' }))
  })
  it('test button surfaces the result', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="notify-test"]').trigger('click')
    await flushPromises()
    expect(w.text()).toMatch(/sent|✅|success/i)
  })
  it('shows the unencrypted-storage warning when tokenStorage is "file" (code review #1)', async () => {
    window.chronos.getNotifySettings = vi.fn(async () => ({ enabled: true, chatId: '42', windowMin: 0, tokenSet: true, tokenStorage: 'file' }))
    const w = mount(SettingsView)
    await flushPromises()
    expect(w.find('[data-test="notify-token-storage-warn"]').exists()).toBe(true)
    expect(w.text()).toMatch(/unencrypted/i)
  })
  it('hides the storage warning when tokenStorage is "keychain"', async () => {
    window.chronos.getNotifySettings = vi.fn(async () => ({ enabled: true, chatId: '42', windowMin: 0, tokenSet: true, tokenStorage: 'keychain' }))
    const w = mount(SettingsView)
    await flushPromises()
    expect(w.find('[data-test="notify-token-storage-warn"]').exists()).toBe(false)
  })
})

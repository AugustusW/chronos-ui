// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetNotifySingleton } from '../../src/renderer/src/stores/notify.store'
import { _resetDbSettingsSingleton } from '../../src/renderer/src/stores/dbsettings.store'
import SettingsView from '../../src/renderer/src/views/SettingsView.vue'

type GlobalWithWindow = typeof globalThis & { window: Record<string, unknown> }

const pgGetStatus = vi.fn()
const pgTestConnection = vi.fn()
const pgSaveSwitch = vi.fn()

beforeEach(() => {
  _resetNotifySingleton()
  _resetDbSettingsSingleton()
  pgGetStatus.mockReset().mockResolvedValue({ activeBackend: 'sqlite', keychainAvailable: true })
  pgTestConnection.mockReset()
  pgSaveSwitch.mockReset().mockResolvedValue({ ok: true })
  const g = globalThis as GlobalWithWindow
  g.window ??= {} as Record<string, unknown>
  g.window.chronos = {
    platform: 'darwin',
    getNotifySettings: vi.fn(async () => ({ enabled: false, chatId: null, windowMin: 0, tokenSet: false })),
    saveNotifySettings: vi.fn(async () => ({ ok: true, settings: { enabled: true, chatId: '42', windowMin: 0, tokenSet: true } })),
    testNotify: vi.fn(async () => ({ ok: true })),
    pgGetStatus, pgTestConnection, pgSaveSwitch
  }
})

describe('SettingsView Database — active=sqlite state (T16)', () => {
  it('shows the sqlite info row and the "Active: SQLite" badge when nothing has switched', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    expect(w.find('[data-test="db-sqlite-info"]').exists()).toBe(true)
    expect(w.find('[data-test="db-active-badge"]').text()).toContain('SQLite')
    expect(w.find('[data-test="db-host"]').exists()).toBe(false) // no form when selection == active == sqlite
  })
})

describe('SettingsView Database — selecting PostgreSQL (T16)', () => {
  it('expands the connection form', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="db-backend-postgres"]').trigger('click')
    expect(w.find('[data-test="db-host"]').exists()).toBe(true)
    expect(w.find('[data-test="db-port"]').exists()).toBe(true)
    expect(w.find('[data-test="db-database"]').exists()).toBe(true)
    expect(w.find('[data-test="db-user"]').exists()).toBe(true)
    expect(w.find('[data-test="db-password"]').exists()).toBe(true)
    expect(w.find('[data-test="db-sslmode"]').exists()).toBe(true)
    expect(w.find('[data-test="db-test"]').exists()).toBe(true)
    expect(w.find('[data-test="db-save-switch"]').exists()).toBe(true)
    expect(w.find('[data-test="db-copydata"]').exists()).toBe(true)
  })

  it('shows the keychain-available muted note when keychainAvailable=true', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="db-backend-postgres"]').trigger('click')
    expect(w.find('[data-test="db-keychain-note"]').exists()).toBe(true)
    expect(w.find('[data-test="db-keychain-warn"]').exists()).toBe(false)
    expect(w.text()).toMatch(/OS keychain/)
  })

  it('shows the keychain-unavailable warning when keychainAvailable=false', async () => {
    pgGetStatus.mockResolvedValue({ activeBackend: 'sqlite', keychainAvailable: false })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="db-backend-postgres"]').trigger('click')
    expect(w.find('[data-test="db-keychain-warn"]').exists()).toBe(true)
    expect(w.find('[data-test="db-keychain-note"]').exists()).toBe(false)
    expect(w.text()).toMatch(/No OS keychain/)
  })

  it('copyData checkbox defaults checked and forwards its value on save', async () => {
    window.confirm = vi.fn(() => true)
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="db-backend-postgres"]').trigger('click')
    const checkbox = w.find('[data-test="db-copydata"]')
    expect((checkbox.element as HTMLInputElement).checked).toBe(true)
    await checkbox.setValue(false)
    await w.find('[data-test="db-host"]').setValue('db.internal')
    await w.find('[data-test="db-save-switch"]').trigger('click')
    await flushPromises()
    expect(pgSaveSwitch).toHaveBeenCalledWith(expect.objectContaining({ copyData: false, targetBackend: 'postgres' }))
  })

  it('does NOT call pgSaveSwitch when the user rejects the restart confirm', async () => {
    window.confirm = vi.fn(() => false)
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="db-backend-postgres"]').trigger('click')
    await w.find('[data-test="db-save-switch"]').trigger('click')
    await flushPromises()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/restart/i))
    expect(pgSaveSwitch).not.toHaveBeenCalled()
  })

  it('calls pgSaveSwitch with the typed fields when the user confirms', async () => {
    window.confirm = vi.fn(() => true)
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="db-backend-postgres"]').trigger('click')
    await w.find('[data-test="db-host"]').setValue('db.internal')
    await w.find('[data-test="db-port"]').setValue('5432')
    await w.find('[data-test="db-database"]').setValue('chronos')
    await w.find('[data-test="db-user"]').setValue('chronos_app')
    await w.find('[data-test="db-password"]').setValue('s3cret')
    await w.find('[data-test="db-save-switch"]').trigger('click')
    await flushPromises()
    expect(pgSaveSwitch).toHaveBeenCalledWith({
      fields: { host: 'db.internal', port: 5432, database: 'chronos', user: 'chronos_app', password: 's3cret', sslmode: 'disable' },
      copyData: true,
      targetBackend: 'postgres'
    })
  })
})

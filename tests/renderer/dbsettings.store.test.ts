// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'

const pgGetStatus = vi.fn()
const pgTestConnection = vi.fn()
const pgSaveSwitch = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
beforeEach(() => { (globalThis as any).window = { chronos: { pgGetStatus, pgTestConnection, pgSaveSwitch } } })

import { createDbSettingsStore } from '../../src/renderer/src/stores/dbsettings.store'

describe('dbsettings store — load (T15)', () => {
  it('load() populates status from pgGetStatus', async () => {
    pgGetStatus.mockResolvedValue({ activeBackend: 'postgres', keychainAvailable: false })
    const s = createDbSettingsStore()
    await s.load()
    expect(s.status).toEqual({ activeBackend: 'postgres', keychainAvailable: false })
  })
  it('load() syncs selectedBackend to the active backend (segmented control reflects reality)', async () => {
    pgGetStatus.mockResolvedValue({ activeBackend: 'postgres', keychainAvailable: true })
    const s = createDbSettingsStore()
    expect(s.selectedBackend).toBe('sqlite') // default before load
    await s.load()
    expect(s.selectedBackend).toBe('postgres')
  })
  it('defaults fields to port 5432 + sslmode disable before any user input', () => {
    const s = createDbSettingsStore()
    expect(s.fields).toEqual({ host: '', port: 5432, database: '', user: '', password: '', sslmode: 'disable' })
  })
  it('defaults copyData to true', () => {
    const s = createDbSettingsStore()
    expect(s.copyData).toBe(true)
  })
})

describe('dbsettings store — selectBackend (T15)', () => {
  it('switches the UI selection and clears any stale test result / error', async () => {
    pgTestConnection.mockResolvedValue({ ok: false, error: 'boom' })
    const s = createDbSettingsStore()
    s.fields.host = 'h'
    await s.test()
    expect(s.testResult).not.toBeNull()
    s.selectBackend('sqlite')
    expect(s.selectedBackend).toBe('sqlite')
    expect(s.testResult).toBeNull()
  })
})

describe('dbsettings store — test (T15)', () => {
  it('sends the current fields to pgTestConnection and stores a success result', async () => {
    pgTestConnection.mockResolvedValue({ ok: true, version: 'PostgreSQL 16.4', ms: 12 })
    const s = createDbSettingsStore()
    s.fields.host = 'db.internal'
    s.fields.database = 'chronos'
    await s.test()
    expect(pgTestConnection).toHaveBeenCalledWith(s.fields)
    expect(s.testResult).toEqual({ ok: true, version: 'PostgreSQL 16.4', ms: 12 })
  })
  it('stores a failure result without throwing', async () => {
    pgTestConnection.mockResolvedValue({ ok: false, error: 'connection refused' })
    const s = createDbSettingsStore()
    await s.test()
    expect(s.testResult).toEqual({ ok: false, error: 'connection refused' })
  })
  it('sets testing=true while the probe is in flight, false after', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    pgTestConnection.mockReturnValue(new Promise((resolve) => { resolveFn = resolve }))
    const s = createDbSettingsStore()
    const p = s.test()
    expect(s.testing).toBe(true)
    resolveFn({ ok: true, version: 'x', ms: 1 })
    await p
    expect(s.testing).toBe(false)
  })
})

describe('dbsettings store — saveSwitch (T15)', () => {
  it('forwards fields + copyData + selectedBackend as targetBackend', async () => {
    pgSaveSwitch.mockResolvedValue({ ok: true })
    const s = createDbSettingsStore()
    s.selectBackend('postgres')
    s.fields.host = 'db.internal'
    s.copyData = false
    await s.saveSwitch()
    expect(pgSaveSwitch).toHaveBeenCalledWith({ fields: s.fields, copyData: false, targetBackend: 'postgres' })
  })
  it('surfaces a failed switch error', async () => {
    pgSaveSwitch.mockResolvedValue({ ok: false, error: 'target Postgres database already has rows in: jobs' })
    const s = createDbSettingsStore()
    s.selectBackend('postgres')
    await s.saveSwitch()
    expect(s.error).toBe('target Postgres database already has rows in: jobs')
  })
  it('clears any prior error on a fresh attempt', async () => {
    pgSaveSwitch.mockResolvedValueOnce({ ok: false, error: 'boom' })
    const s = createDbSettingsStore()
    s.selectBackend('postgres')
    await s.saveSwitch()
    expect(s.error).toBe('boom')
    pgSaveSwitch.mockResolvedValueOnce({ ok: true })
    await s.saveSwitch()
    expect(s.error).toBeNull()
  })
  it('sets switching=true while the request is in flight, false after', async () => {
    let resolveFn: (v: unknown) => void = () => {}
    pgSaveSwitch.mockReturnValue(new Promise((resolve) => { resolveFn = resolve }))
    const s = createDbSettingsStore()
    const p = s.saveSwitch()
    expect(s.switching).toBe(true)
    resolveFn({ ok: true })
    await p
    expect(s.switching).toBe(false)
  })
  it('switching back to sqlite sends targetBackend=sqlite regardless of stale field contents', async () => {
    pgSaveSwitch.mockResolvedValue({ ok: true })
    const s = createDbSettingsStore()
    s.selectBackend('sqlite')
    await s.saveSwitch()
    expect(pgSaveSwitch).toHaveBeenCalledWith(expect.objectContaining({ targetBackend: 'sqlite' }))
  })
})

describe('dbsettings store — singleton (T15)', () => {
  it('useDbSettingsStore returns the same instance until reset', async () => {
    const { useDbSettingsStore, _resetDbSettingsSingleton } = await import('../../src/renderer/src/stores/dbsettings.store')
    const a = useDbSettingsStore()
    const b = useDbSettingsStore()
    expect(a).toBe(b)
    _resetDbSettingsSingleton()
    const c = useDbSettingsStore()
    expect(c).not.toBe(a)
  })
})

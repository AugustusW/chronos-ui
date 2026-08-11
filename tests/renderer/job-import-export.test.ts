// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { _resetNotifySingleton } from '../../src/renderer/src/stores/notify.store'
import { _resetDbSettingsSingleton } from '../../src/renderer/src/stores/dbsettings.store'
import SettingsView from '../../src/renderer/src/views/SettingsView.vue'

type GlobalWithWindow = typeof globalThis & { window: Record<string, unknown> }

const exportJobsYaml = vi.fn()
const importJobsPreview = vi.fn()
const importJobsApply = vi.fn()

beforeEach(() => {
  _resetNotifySingleton()
  _resetDbSettingsSingleton()
  exportJobsYaml.mockReset()
  importJobsPreview.mockReset()
  importJobsApply.mockReset()
  const g = globalThis as GlobalWithWindow
  g.window ??= {} as Record<string, unknown>
  g.window.chronos = {
    platform: 'darwin',
    getNotifySettings: vi.fn(async () => ({ enabled: false, chatId: null, windowMin: 0, nativeEnabled: true, tokenSet: false })),
    saveNotifySettings: vi.fn(async () => ({ ok: true })),
    testNotify: vi.fn(async () => ({ ok: true })),
    pgGetStatus: vi.fn(async () => ({ activeBackend: 'sqlite', keychainAvailable: true })),
    exportJobsYaml, importJobsPreview, importJobsApply
  }
})

describe('SettingsView — Job Definitions (export)', () => {
  it('renders the Job Definitions section', async () => {
    const w = mount(SettingsView)
    await flushPromises()
    expect(w.text()).toContain('Job Definitions')
  })

  it('export button calls exportJobsYaml and shows the resulting path', async () => {
    exportJobsYaml.mockResolvedValue({ status: 'ok', path: '/Users/x/chronos-jobs.yaml' })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="export-all-jobs"]').trigger('click')
    await flushPromises()
    expect(exportJobsYaml).toHaveBeenCalledWith()
    expect(w.find('[data-test="export-status"]').text()).toContain('/Users/x/chronos-jobs.yaml')
  })

  it('a canceled export dialog shows no status message', async () => {
    exportJobsYaml.mockResolvedValue({ status: 'canceled' })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="export-all-jobs"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="export-status"]').exists()).toBe(false)
  })

  it('an export error is surfaced', async () => {
    exportJobsYaml.mockResolvedValue({ status: 'error', error: 'No jobs to export' })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="export-all-jobs"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="export-status"]').text()).toContain('No jobs to export')
  })
})

describe('SettingsView — Job Definitions (import)', () => {
  const preview = {
    fileName: 'jobs.yaml',
    entries: [
      { kind: 'new' as const, entry: { name: 'A', scheduleExpr: '* * * * *', command: 'x' } },
      { kind: 'changed' as const, entry: { name: 'B', scheduleExpr: '* * * * *', command: 'y' }, existingId: 2, changedFields: ['command'] },
      { kind: 'unchanged' as const, entry: { name: 'C', scheduleExpr: '* * * * *', command: 'z' }, existingId: 3 }
    ]
  }

  it('opens the preview dialog on a successful preview, showing new/changed/unchanged counts', async () => {
    importJobsPreview.mockResolvedValue({ status: 'ok', preview })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(true)
    expect(w.text()).toContain('jobs.yaml')
    expect(w.find('[data-test="count-new"]').text()).toBe('1 new')
    expect(w.find('[data-test="count-changed"]').text()).toBe('1 changed')
    expect(w.find('[data-test="count-unchanged"]').text()).toBe('1 unchanged')
    expect(w.findAll('[data-test="diff-row"]')).toHaveLength(3)
  })

  it('a canceled preview dialog opens no import dialog and shows no error', async () => {
    importJobsPreview.mockResolvedValue({ status: 'canceled' })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(w.find('[data-test="import-status"]').exists()).toBe(false)
  })

  it('a preview error is surfaced without opening the dialog', async () => {
    importJobsPreview.mockResolvedValue({ status: 'error', error: 'Invalid YAML' })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(w.find('[data-test="import-status"]').text()).toContain('Invalid YAML')
  })

  it('Cancel in the dialog closes it without calling applyImport', async () => {
    importJobsPreview.mockResolvedValue({ status: 'ok', preview })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="import-cancel"]').trigger('click')
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(importJobsApply).not.toHaveBeenCalled()
  })

  it('Confirm sends every previewed entry (new/changed/unchanged alike) to importJobsApply, then reports the result and closes', async () => {
    importJobsPreview.mockResolvedValue({ status: 'ok', preview })
    importJobsApply.mockResolvedValue({ ok: true, created: 1, updated: 1, errors: [] })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="import-confirm"]').trigger('click')
    await flushPromises()
    expect(importJobsApply).toHaveBeenCalledWith(preview.entries.map((e) => e.entry))
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(w.find('[data-test="import-status"]').text()).toContain('1 created, 1 updated')
  })

  it('an apply with errors still closes the dialog and reports the failures', async () => {
    importJobsPreview.mockResolvedValue({ status: 'ok', preview })
    importJobsApply.mockResolvedValue({ ok: false, created: 1, updated: 0, errors: ['B: adapter rejected'] })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    await w.find('[data-test="import-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="import-status"]').text()).toContain('errors')
    expect(w.find('[data-test="import-status"]').text()).toContain('adapter rejected')
  })

  it('the Confirm button is disabled while applying is in flight', async () => {
    importJobsPreview.mockResolvedValue({ status: 'ok', preview })
    let resolveApply!: (v: unknown) => void
    importJobsApply.mockReturnValue(new Promise((res) => { resolveApply = res }))
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    const confirmBtn = w.find('[data-test="import-confirm"]')
    void confirmBtn.trigger('click')
    await flushPromises()
    expect((w.find('[data-test="import-confirm"]').element as HTMLButtonElement).disabled).toBe(true)
    resolveApply({ ok: true, created: 0, updated: 0, errors: [] })
    await flushPromises()
  })

  it('Confirm is disabled when there is nothing to apply (all unchanged)', async () => {
    importJobsPreview.mockResolvedValue({
      status: 'ok',
      preview: { fileName: 'jobs.yaml', entries: [{ kind: 'unchanged' as const, entry: { name: 'C', scheduleExpr: '* * * * *', command: 'z' }, existingId: 3 }] }
    })
    const w = mount(SettingsView)
    await flushPromises()
    await w.find('[data-test="import-jobs"]').trigger('click')
    await flushPromises()
    expect((w.find('[data-test="import-confirm"]').element as HTMLButtonElement).disabled).toBe(true)
  })
})

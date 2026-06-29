// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JobRow from '../../src/renderer/src/components/JobRow.vue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const item: any = { status: 'in_sync', job: { id: 1, name: 'Nightly backup', category: 'backups', scheduleExpr: '0 3 * * *', command: '/b.sh', enabled: true, adopted: true, lastResult: 'success', lastRunAt: Date.now() }, native: {} }

describe('JobRow', () => {
  it('shows the humanized schedule + raw cron + wrapped chip; emits run', async () => {
    const w = mount(JobRow, { props: { item, selectMode: false, selected: false, running: false } })
    expect(w.text()).toContain('Daily at 03:00')
    expect(w.text()).toContain('0 3 * * *')
    expect(w.text()).toContain('wrapped')
    await w.find('[data-run]').trigger('click')
    expect(w.emitted('run')).toBeTruthy()
  })
  it('shows a running spinner when running', () => {
    const w = mount(JobRow, { props: { item, selectMode: false, selected: false, running: true } })
    expect(w.find('[data-running]').exists()).toBe(true)
  })
  it('clicking the detail affordance (.meta) emits open-detail', async () => {
    const w = mount(JobRow, { props: { item, selectMode: false, selected: false, running: false } })
    await w.find('[data-detail]').trigger('click')
    expect(w.emitted('open-detail')).toBeTruthy()
  })
  it('clicking Run button does NOT emit open-detail', async () => {
    const w = mount(JobRow, { props: { item, selectMode: false, selected: false, running: false } })
    await w.find('[data-run]').trigger('click')
    expect(w.emitted('open-detail')).toBeFalsy()
  })

  it('unmanaged row has NO Run button but DOES have Adopt button', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const um: any = { status: 'unmanaged', native: { name: 'BackupJob', command: 'C:\\backup\\run.exe --full', scheduleExpr: '0 9 * * 1', adopted: false, enabled: true } }
    const w = mount(JobRow, { props: { item: um, selectMode: false, selected: false, running: false } })
    expect(w.find('[data-run]').exists()).toBe(false)
    expect(w.text()).toContain('Adopt')
  })

  it('managed row HAS Run button', () => {
    const w = mount(JobRow, { props: { item, selectMode: false, selected: false, running: false } })
    expect(w.find('[data-run]').exists()).toBe(true)
  })

  it('shows the native name for an unmanaged Windows task (#8)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const um: any = { status: 'unmanaged', native: { name: 'BackupJob', command: 'C:\\backup\\run.exe --full', scheduleExpr: '0 9 * * 1', adopted: false, enabled: true } }
    const w = mount(JobRow, { props: { item: um, selectMode: false, selected: false, running: false } })
    expect(w.find('.name').text()).toContain('BackupJob')
  })

  it('does NOT use the command/path as the name for an unmanaged cron entry; command stays in the cmd line (#8)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const um: any = { status: 'unmanaged', native: { command: '/Users/x/scripts/steam_fetch.py >> /var/log/x.log 2>&1', scheduleExpr: '0 3 * * *', adopted: false, enabled: true } }
    const w = mount(JobRow, { props: { item: um, selectMode: false, selected: false, running: false } })
    expect(w.find('.name').text()).not.toContain('steam_fetch.py') // name is blank, not the command
    expect(w.find('.cmd').text()).toContain('steam_fetch.py') // command still shown below
  })

  // orphan_native: a `# chronos:<id>` marker whose DB row is gone (partial delete / stale restore).
  // reconcile yields { status:'orphan_native', native } with NO `job` — rendering must not crash.
  it('renders an orphan_native row without crashing; falls back to the native name', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orphan: any = { status: 'orphan_native', native: { name: 'StaleTask', command: 'C:\\x\\run.exe', scheduleExpr: '0 3 * * *', adopted: true, enabled: true } }
    const w = mount(JobRow, { props: { item: orphan, selectMode: false, selected: false, running: false } })
    expect(w.find('.name').text()).toContain('StaleTask')
  })

  it('renders a cron orphan_native (no native name) as a blank name without crashing; command stays in the cmd line', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orphan: any = { status: 'orphan_native', native: { command: '/Users/x/scripts/cleanup.sh', scheduleExpr: '0 3 * * *', adopted: true, enabled: true } }
    const w = mount(JobRow, { props: { item: orphan, selectMode: false, selected: false, running: false } })
    expect(w.find('.name').text()).not.toContain('cleanup.sh') // name blank, not the command
    expect(w.find('.cmd').text()).toContain('cleanup.sh') // command still shown
  })
})

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
})

// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RunHistoryList from '../../src/renderer/src/components/RunHistoryList.vue'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runs: any = [{ id: 1, triggeredBy: 'schedule', result: 'failure', startedAt: Date.now(), durationMs: 1800, exitCode: 23 }]
describe('RunHistoryList', () => {
  it('renders a run with result badge + trigger + duration, emits select', async () => {
    const w = mount(RunHistoryList, { props: { runs } })
    expect(w.text()).toContain('schedule')
    await w.find('[data-run-id="1"]').trigger('click')
    expect(w.emitted('select')).toBeTruthy()
  })
})

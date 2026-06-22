// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BatchActionBar from '../../src/renderer/src/components/BatchActionBar.vue'

describe('BatchActionBar', () => {
  it('shows the selected count + emits actions', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = mount(BatchActionBar, { props: { count: 2 } })
    expect(w.text()).toContain('2 selected')
    await w.find('[data-act="delete"]').trigger('click')
    expect(w.emitted('delete')).toBeTruthy()
  })
  it('shows live progress when running', () => {
    const w = mount(BatchActionBar, { props: { count: 2, running: { done: 1, total: 2 } } })
    expect(w.text()).toContain('1 of 2 done')
  })
})

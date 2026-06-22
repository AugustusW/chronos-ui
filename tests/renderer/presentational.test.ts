// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBadge from '../../src/renderer/src/components/StatusBadge.vue'
import SkeletonRows from '../../src/renderer/src/components/SkeletonRows.vue'

describe('StatusBadge', () => {
  it('renders the label and a shape/icon (not color-only — WCAG 1.4.1)', () => {
    const w = mount(StatusBadge, { props: { status: 'warn', label: 'timeout' } })
    expect(w.text()).toContain('timeout')
    expect(w.find('[data-icon]').exists()).toBe(true) // icon carries meaning beyond color
  })
})
describe('SkeletonRows', () => {
  it('renders the requested number of shimmer rows', () => {
    const w = mount(SkeletonRows, { props: { count: 3 } })
    expect(w.findAll('.sk-row').length).toBe(3)
  })
})

// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CronPreview from '../../src/renderer/src/components/CronPreview.vue'
describe('CronPreview', () => {
  it('shows the human-readable schedule', () => {
    expect(mount(CronPreview, { props: { expr: '0 3 * * *' } }).text()).toContain('Daily at 03:00')
  })
})

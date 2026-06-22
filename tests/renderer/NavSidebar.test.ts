// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, RouterLinkStub, flushPromises } from '@vue/test-utils'
import NavSidebar from '../../src/renderer/src/components/NavSidebar.vue'

beforeEach(() => {
  // Provide a minimal window.chronos so onMounted guard doesn't throw
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = {
    chronos: { getVersion: vi.fn().mockResolvedValue({ name: 'chronos-ui', version: '0.0.0' }) }
  }
})

describe('NavSidebar', () => {
  it('renders the brand with the Ordered Dial SVG (not an emoji) + nav links', async () => {
    const w = mount(NavSidebar, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(w.find('svg.dial').exists()).toBe(true)   // design-director D3: dial, never emoji
    expect(w.text()).toContain('ChronosUI')
    expect(w.text()).toContain('Schedules')
  })

  it('displays the live version fetched from window.chronos.getVersion', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = {
      chronos: { getVersion: vi.fn().mockResolvedValue({ name: 'chronos-ui', version: '9.9.9' }) }
    }
    const w = mount(NavSidebar, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(w.text()).toContain('9.9.9')
  })
})

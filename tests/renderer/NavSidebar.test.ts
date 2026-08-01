// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, RouterLinkStub, flushPromises } from '@vue/test-utils'
import NavSidebar from '../../src/renderer/src/components/NavSidebar.vue'
import { router } from '../../src/renderer/src/router'

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
    expect(w.text()).toContain('Dashboard')
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

  it('declares exactly 4 nav items with Dashboard at / and Schedules at /schedules', async () => {
    const w = mount(NavSidebar, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    const links = w.findAllComponents(RouterLinkStub)
    expect(links.length).toBe(4)
    const dashboard = links.find((l) => l.props('to') === '/')
    const schedules = links.find((l) => l.props('to') === '/schedules')
    expect(dashboard).toBeTruthy()
    expect(dashboard!.text()).toContain('Dashboard')
    expect(schedules).toBeTruthy()
    expect(schedules!.text()).toContain('Schedules')
  })

  it('renders nav items in the fixed order Dashboard, Schedules, Run History, Settings', async () => {
    const w = mount(NavSidebar, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    const links = w.findAllComponents(RouterLinkStub)
    expect(links.map((l) => l.props('to'))).toEqual(['/', '/schedules', '/history', '/settings'])
  })

  it('does not mark the Dashboard link active when the current route is /schedules (real router, not stub)', async () => {
    await router.push('/schedules')
    await router.isReady()
    const w = mount(NavSidebar, { global: { plugins: [router] } })
    await flushPromises()
    const anchors = w.findAll('a.item')
    const dashboardLink = anchors.find((a) => a.text().includes('Dashboard'))
    const schedulesLink = anchors.find((a) => a.text().includes('Schedules'))
    expect(dashboardLink).toBeTruthy()
    expect(schedulesLink).toBeTruthy()
    expect(dashboardLink!.classes()).not.toContain('active')
    expect(schedulesLink!.classes()).toContain('active')
    // Reset the shared router singleton so it doesn't leak state into other tests.
    await router.push('/')
  })
})

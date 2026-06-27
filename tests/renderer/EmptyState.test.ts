// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import EmptyState from '../../src/renderer/src/components/EmptyState.vue'

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = { chronos: { platform: 'darwin' } }
})

describe('EmptyState', () => {
  it('mac wording says crontab', () => {
    const w = mount(EmptyState, { props: { scanning: false, scanned: false } })
    expect(w.text()).toContain('Scan crontab')
  })

  it('windows wording says Task Scheduler, never crontab (#3)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { chronos: { platform: 'win32' } }
    const w = mount(EmptyState, { props: { scanning: false, scanned: false } })
    expect(w.text()).toContain('Scan Task Scheduler')
    expect(w.text()).not.toContain('crontab')
  })

  it('shows Scanning… and disables the button while scanning (#2)', () => {
    const w = mount(EmptyState, { props: { scanning: true, scanned: false } })
    const btn = w.find('button.primary')
    expect(btn.text()).toContain('Scanning')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('shows a no-jobs-found note after an empty scan (#2)', () => {
    const w = mount(EmptyState, { props: { scanning: false, scanned: true } })
    expect(w.text()).toMatch(/No scheduled jobs found/i)
  })

  it('does not show the no-jobs note before any scan', () => {
    const w = mount(EmptyState, { props: { scanning: false, scanned: false } })
    expect(w.text()).not.toMatch(/No scheduled jobs found/i)
  })
})

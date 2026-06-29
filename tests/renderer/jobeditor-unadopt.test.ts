// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import JobEditor from '../../src/renderer/src/components/JobEditor.vue'

describe('JobEditor Un-adopt button', () => {
  it('shows [data-unadopt] button when adopted=true', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: true }
    })
    expect(w.find('[data-unadopt]').exists()).toBe(true)
  })

  it('does NOT show [data-unadopt] button when adopted=false', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: false }
    })
    expect(w.find('[data-unadopt]').exists()).toBe(false)
  })

  it('does NOT show [data-unadopt] button when adopted is omitted', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' } }
    })
    expect(w.find('[data-unadopt]').exists()).toBe(false)
  })

  it('emits unadopt when confirm returns true', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: true }
    })
    await w.find('[data-unadopt]').trigger('click')
    expect(w.emitted('unadopt')).toBeTruthy()
    vi.restoreAllMocks()
  })

  it('does NOT emit unadopt when confirm returns false', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: true }
    })
    await w.find('[data-unadopt]').trigger('click')
    expect(w.emitted('unadopt')).toBeFalsy()
    vi.restoreAllMocks()
  })
})

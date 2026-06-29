// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import JobEditor from '../../src/renderer/src/components/JobEditor.vue'

describe('JobEditor Forget button', () => {
  it('shows [data-forget] when initial && !adopted, hides [data-unadopt]', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: false }
    })
    expect(w.find('[data-forget]').exists()).toBe(true)
    expect(w.find('[data-unadopt]').exists()).toBe(false)
  })

  it('shows [data-unadopt] when initial && adopted=true, hides [data-forget]', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: true }
    })
    expect(w.find('[data-unadopt]').exists()).toBe(true)
    expect(w.find('[data-forget]').exists()).toBe(false)
  })

  it('shows neither [data-forget] nor [data-unadopt] when no initial (new job)', () => {
    const w = mount(JobEditor, {
      props: { open: true }
    })
    expect(w.find('[data-forget]').exists()).toBe(false)
    expect(w.find('[data-unadopt]').exists()).toBe(false)
  })

  it('emits forget when confirm returns true', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: false }
    })
    await w.find('[data-forget]').trigger('click')
    expect(w.emitted('forget')).toBeTruthy()
    vi.restoreAllMocks()
  })

  it('does NOT emit forget when confirm returns false', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' }, adopted: false }
    })
    await w.find('[data-forget]').trigger('click')
    expect(w.emitted('forget')).toBeFalsy()
    vi.restoreAllMocks()
  })
})

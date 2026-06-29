// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JobEditor from '../../src/renderer/src/components/JobEditor.vue'

describe('JobEditor notifyOnFailure', () => {
  it('renders the checkbox reflecting the initial value (true)', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x', notifyOnFailure: true } }
    })
    expect((w.find('[data-test="job-notify"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('renders the checkbox unchecked when notifyOnFailure is false', () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x', notifyOnFailure: false } }
    })
    expect((w.find('[data-test="job-notify"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('includes notifyOnFailure in the save payload after toggling', async () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x', notifyOnFailure: false } }
    })
    await w.find('[data-test="job-notify"]').setValue(true)
    await w.find('[data-save]').trigger('click')
    const emitted = w.emitted('save') as unknown[][]
    expect(emitted.at(-1)?.[0]).toEqual(expect.objectContaining({ notifyOnFailure: true }))
  })

  it('defaults notifyOnFailure to false when not provided in initial', async () => {
    const w = mount(JobEditor, {
      props: { open: true, initial: { name: 'j', scheduleExpr: '* * * * *', command: 'x' } }
    })
    await w.find('[data-save]').trigger('click')
    const emitted = w.emitted('save') as unknown[][]
    expect(emitted.at(-1)?.[0]).toEqual(expect.objectContaining({ notifyOnFailure: false }))
  })
})

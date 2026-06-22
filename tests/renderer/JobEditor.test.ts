// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import JobEditor from '../../src/renderer/src/components/JobEditor.vue'
describe('JobEditor', () => {
  it('emits save with the form values', async () => {
    const w = mount(JobEditor, { props: { open: true } })
    await w.find('[data-f="name"]').setValue('Backup')
    await w.find('[data-f="schedule"]').setValue('0 3 * * *')
    await w.find('[data-f="command"]').setValue('/b.sh')
    await w.find('[data-save]').trigger('click')
    expect(w.emitted('save')![0][0]).toMatchObject({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/b.sh' })
  })

  it('emits cancel when the cancel button is clicked', async () => {
    const w = mount(JobEditor, { props: { open: true } })
    await w.find('button:not([data-save])').trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
  })

  it('emits cancel when Escape is pressed on the overlay', async () => {
    const w = mount(JobEditor, { props: { open: true } })
    await w.find('.overlay').trigger('keydown.escape')
    expect(w.emitted('cancel')).toBeTruthy()
  })

  it('has aria-modal, aria-labelledby on the dialog and id on the heading', () => {
    const w = mount(JobEditor, { props: { open: true } })
    const dialog = w.find('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-labelledby')).toBe('job-editor-title')
    expect(w.find('#job-editor-title').exists()).toBe(true)
  })

  it('prefills the form when opened with an initial prop', async () => {
    const w = mount(JobEditor, { props: { open: false } })
    // Open with initial values
    await w.setProps({ open: true, initial: { name: 'X', scheduleExpr: '0 1 * * *', command: '/x' } })
    await flushPromises()
    await nextTick()
    expect((w.find('[data-f="name"]').element as HTMLInputElement).value).toBe('X')
    expect((w.find('[data-f="schedule"]').element as HTMLInputElement).value).toBe('0 1 * * *')
    expect((w.find('[data-f="command"]').element as HTMLTextAreaElement).value).toBe('/x')
  })

  it('resets the form to blank when reopened without initial', async () => {
    const w = mount(JobEditor, { props: { open: true, initial: { name: 'Old', scheduleExpr: '0 5 * * *', command: '/old' } } })
    await flushPromises()
    // Close, clear initial, reopen
    await w.setProps({ open: false, initial: undefined })
    await flushPromises()
    await w.setProps({ open: true })
    await flushPromises()
    await nextTick()
    expect((w.find('[data-f="name"]').element as HTMLInputElement).value).toBe('')
    expect((w.find('[data-f="command"]').element as HTMLTextAreaElement).value).toBe('')
  })
})

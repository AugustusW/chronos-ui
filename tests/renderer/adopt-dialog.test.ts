// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AdoptDialog from '../../src/renderer/src/components/AdoptDialog.vue'

const BASE_PROPS = {
  open: true,
  schedule: '0 3 * * *',
  command: '/usr/bin/pg_dump assistant',
  defaultName: 'pg_dump',
}

describe('AdoptDialog', () => {
  it('renders when open=true', () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    expect(w.find('.overlay').exists()).toBe(true)
  })

  it('does not render when open=false', () => {
    const w = mount(AdoptDialog, { props: { ...BASE_PROPS, open: false } })
    expect(w.find('.overlay').exists()).toBe(false)
  })

  it('shows schedule as read-only text (not an editable input)', () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    // schedule shown in a .ro element
    expect(w.find('[data-ro="schedule"]').exists()).toBe(true)
    expect(w.find('[data-ro="schedule"]').text()).toContain('0 3 * * *')
    // must NOT be inside an input or textarea
    expect(w.find('input[data-f="schedule"]').exists()).toBe(false)
    expect(w.find('textarea[data-f="schedule"]').exists()).toBe(false)
  })

  it('shows command as read-only text (not an editable input)', () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    expect(w.find('[data-ro="command"]').exists()).toBe(true)
    expect(w.find('[data-ro="command"]').text()).toContain('/usr/bin/pg_dump assistant')
    expect(w.find('input[data-f="command"]').exists()).toBe(false)
    expect(w.find('textarea[data-f="command"]').exists()).toBe(false)
  })

  it('name input is EMPTY on open (not pre-filled with defaultName)', () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    const nameInput = w.find<HTMLInputElement>('[data-f="name"]')
    expect(nameInput.exists()).toBe(true)
    expect(nameInput.element.value).toBe('')
  })

  it('name input placeholder equals defaultName prop', () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    const nameInput = w.find<HTMLInputElement>('[data-f="name"]')
    expect(nameInput.attributes('placeholder')).toBe('pg_dump')
  })

  it('emits adopt with name and category on confirm', async () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    await w.find('[data-f="name"]').setValue('my_backup')
    await w.find('[data-f="category"]').setValue('backups')
    await w.find('[data-adopt]').trigger('click')
    const emitted = w.emitted('adopt') as unknown[][]
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toEqual({ name: 'my_backup', category: 'backups' })
  })

  it('emits adopt with empty name when name not set', async () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    await w.find('[data-adopt]').trigger('click')
    const emitted = w.emitted('adopt') as unknown[][]
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toEqual(expect.objectContaining({ name: '' }))
  })

  it('emits cancel when Cancel button clicked', async () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    await w.find('[data-cancel]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('emits cancel on Escape key', async () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    await w.find('.overlay').trigger('keydown.escape')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('placeholder reflects updated defaultName when prop changes', async () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    await w.setProps({ defaultName: 'new_default' })
    const nameInput = w.find<HTMLInputElement>('[data-f="name"]')
    expect(nameInput.attributes('placeholder')).toBe('new_default')
    // value stays empty (user hasn't typed anything)
    expect(nameInput.element.value).toBe('')
  })

  it('shows the reversibility reassurance note', () => {
    const w = mount(AdoptDialog, { props: BASE_PROPS })
    expect(w.find('.note').exists()).toBe(true)
    expect(w.find('.note').text()).toContain('fully reversible')
  })
})

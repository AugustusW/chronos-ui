// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import App from '../src/renderer/src/App.vue'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('App.vue (shell)', () => {
  it('renders the NavSidebar brand text', () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          RouterView: true,
          RouterLink: RouterLinkStub
        }
      }
    })
    expect(wrapper.text()).toContain('ChronosUI')
  })

  it('applies the stored theme on mount (data-theme attribute set)', async () => {
    localStorage.setItem('chronos.theme', 'dark')
    mount(App, {
      global: {
        stubs: {
          RouterView: true,
          RouterLink: RouterLinkStub
        }
      }
    })
    // onMounted applies stored theme
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

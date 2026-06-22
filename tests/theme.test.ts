// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { applyTheme, getStoredTheme, THEMES } from '../src/renderer/src/lib/theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('theme', () => {
  it('lists the built-in themes', () => {
    expect(THEMES).toEqual(['light', 'dark'])
  })

  it('defaults to light when nothing is stored', () => {
    expect(getStoredTheme()).toBe('light')
  })

  it('applies the theme to the document and persists it', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(getStoredTheme()).toBe('dark')
  })

  it('falls back to light for an unknown stored value', () => {
    localStorage.setItem('chronos.theme', 'banana')
    expect(getStoredTheme()).toBe('light')
  })
})

describe('Plan 6 design tokens', () => {
  it('declares the nav + AA-text + focus-ring families (light)', async () => {
    // load the stylesheet text and assert the token names are declared (jsdom getComputedStyle won't chain var()).
    const fs = await import('fs')
    const path = await import('path')
    const css = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/assets/tokens.semantic.css'), 'utf8')
    for (const t of ['--nav-bg', '--nav-active-text', '--color-ok-text', '--color-danger-text', '--color-shimmer-base', '--color-stderr-text', '--color-off']) {
      expect(css).toContain(t)
    }
    const comp = fs.readFileSync(path.resolve(__dirname, '../src/renderer/src/assets/tokens.component.css'), 'utf8')
    expect(comp).toContain('--focus-ring-color')
    applyTheme('dark'); expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

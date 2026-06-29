// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { buildCspContent, isInternalNavigation, installNavigationHardening, type WebContentsLike } from '../src/main/window-security'

describe('buildCspContent (code review #2)', () => {
  const csp = buildCspContent()
  it('locks the default origin to self and closes object/frame/form sinks', () => {
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'self'")
  })
  it('never allows unsafe-eval, and does not relax script-src to inline', () => {
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })
  it('allows inline styles (required by Vue runtime style bindings)', () => {
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
  })
})

describe('isInternalNavigation (code review #3)', () => {
  it('allows same dev-server origin, denies external', () => {
    expect(isInternalNavigation('http://localhost:5173/x', 'http://localhost:5173/')).toBe(true)
    expect(isInternalNavigation('https://evil.example/', 'http://localhost:5173/')).toBe(false)
  })
  it('allows file:// within a packaged build, denies http from file://', () => {
    expect(isInternalNavigation('file:///app/renderer/index.html', 'file:///app/renderer/index.html')).toBe(true)
    expect(isInternalNavigation('https://evil.example/', 'file:///app/renderer/index.html')).toBe(false)
  })
  it('denies a malformed target', () => {
    expect(isInternalNavigation('not a url', 'http://localhost:5173/')).toBe(false)
  })
})

describe('installNavigationHardening (code review #3)', () => {
  function fakeWc() {
    let openHandler: ((d: { url: string }) => { action: string }) | undefined
    let navListener: ((e: { preventDefault(): void }, url: string) => void) | undefined
    const wc: WebContentsLike = {
      setWindowOpenHandler: (h) => { openHandler = h as never },
      on: (_e, l) => { navListener = l as never }
    }
    return { wc, getOpen: () => openHandler!, getNav: () => navListener! }
  }
  it('denies all window.open and routes http(s) to the system browser', () => {
    const openExternal = vi.fn()
    const f = fakeWc()
    installNavigationHardening(f.wc, () => 'http://localhost:5173/', openExternal)
    expect(f.getOpen()({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })
  it('does not open non-http schemes externally but still denies the popup', () => {
    const openExternal = vi.fn()
    const f = fakeWc()
    installNavigationHardening(f.wc, () => 'http://localhost:5173/', openExternal)
    expect(f.getOpen()({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })
  it('prevents navigation to an external URL but allows the app URL', () => {
    const f = fakeWc()
    installNavigationHardening(f.wc, () => 'http://localhost:5173/', vi.fn())
    const ePrevent = { preventDefault: vi.fn() }
    f.getNav()(ePrevent, 'https://evil.example/')
    expect(ePrevent.preventDefault).toHaveBeenCalled()
    const eAllow = { preventDefault: vi.fn() }
    f.getNav()(eAllow, 'http://localhost:5173/dashboard')
    expect(eAllow.preventDefault).not.toHaveBeenCalled()
  })
})

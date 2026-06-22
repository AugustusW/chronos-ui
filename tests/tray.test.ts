// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { createTray } from '../src/main/tray'

function fakeTray() {
  const t = { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() }
  const TrayCtor = vi.fn(() => t) as unknown as never
  return { t, TrayCtor }
}
function fakeMenu() {
  const items: Array<{ label: string; click: () => void }> = []
  const Menu = { buildFromTemplate: vi.fn((tpl: typeof items) => { items.push(...tpl); return { _tpl: tpl } }) } as unknown as never
  return { items, Menu }
}

describe('createTray', () => {
  it('builds a tray with Open + Quit menu items wired to the callbacks', () => {
    const { t, TrayCtor } = fakeTray(); const { items, Menu } = fakeMenu()
    const onOpen = vi.fn(); const onQuit = vi.fn()
    createTray({ onOpen, onQuit, TrayCtor, Menu, iconPath: '/x/icon.png' })
    expect(TrayCtor).toHaveBeenCalledWith('/x/icon.png')
    expect(t.setContextMenu).toHaveBeenCalled()
    const labels = items.map((i) => i.label)
    expect(labels).toContain('Open ChronosUI')
    expect(labels).toContain('Quit')
    items.find((i) => i.label === 'Open ChronosUI')!.click(); expect(onOpen).toHaveBeenCalled()
    items.find((i) => i.label === 'Quit')!.click(); expect(onQuit).toHaveBeenCalled()
  })
  it('destroy() tears down the tray', () => {
    const { t, TrayCtor } = fakeTray(); const { Menu } = fakeMenu()
    const h = createTray({ onOpen: vi.fn(), onQuit: vi.fn(), TrayCtor, Menu, iconPath: '/x/icon.png' })
    h.destroy(); expect(t.destroy).toHaveBeenCalled()
  })
})

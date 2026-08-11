// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { createTray } from '../src/main/tray'
import type { DashboardSummary } from '../src/main/services/dashboard.service'
import type { TrayMenuItemTemplate } from '../src/main/tray-menu'

function fakeTray() {
  const t = {
    setToolTip: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn()
  }
  const TrayCtor = vi.fn(() => t) as unknown as never
  return { t, TrayCtor }
}
function fakeMenu() {
  const built: Array<{ items: TrayMenuItemTemplate[]; on: ReturnType<typeof vi.fn> }> = []
  const Menu = {
    buildFromTemplate: vi.fn((tpl: TrayMenuItemTemplate[]) => {
      const instance = { on: vi.fn() }
      built.push({ items: tpl, on: instance.on })
      return instance
    })
  } as unknown as never
  return { built, Menu, latest: () => built[built.length - 1] }
}
function summary(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    runsToday: 0,
    succeededToday: 0,
    failedToday: 0,
    activeJobs: 0,
    failures: [],
    failuresTotal: 0,
    upcoming: [],
    generatedAt: 0,
    ...over
  }
}
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createTray', () => {
  it('builds a tray with Open + Quit menu items wired to the callbacks (no getSummary supplied)', () => {
    const { t, TrayCtor } = fakeTray()
    const { built, Menu } = fakeMenu()
    const onOpen = vi.fn()
    const onQuit = vi.fn()
    createTray({ onOpen, onQuit, TrayCtor, Menu, iconPath: '/x/icon.png' })
    expect(TrayCtor).toHaveBeenCalledWith('/x/icon.png')
    expect(t.setContextMenu).toHaveBeenCalled()
    const labels = built[0].items.map((i) => i.label)
    expect(labels).toContain('Open ChronosUI')
    expect(labels).toContain('Quit')
    built[0].items.find((i) => i.label === 'Open ChronosUI')!.click!()
    expect(onOpen).toHaveBeenCalled()
    built[0].items.find((i) => i.label === 'Quit')!.click!()
    expect(onQuit).toHaveBeenCalled()
  })

  it('destroy() tears down the tray', () => {
    const { t, TrayCtor } = fakeTray()
    const { Menu } = fakeMenu()
    const h = createTray({
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      TrayCtor,
      Menu,
      iconPath: '/x/icon.png'
    })
    h.destroy()
    expect(t.destroy).toHaveBeenCalled()
  })

  it('renders the dashboard summary into the menu/tooltip once getSummary resolves', async () => {
    const { t, TrayCtor } = fakeTray()
    const { built, Menu } = fakeMenu()
    const getSummary = vi.fn(async () => summary({ succeededToday: 3, failedToday: 1 }))
    createTray({
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      TrayCtor,
      Menu,
      iconPath: '/x/icon.png',
      getSummary
    })
    await flush()
    expect(getSummary).toHaveBeenCalled()
    // Second (async) render replaces the initial placeholder build.
    const last = built[built.length - 1]
    expect(last.items.map((i) => i.label)).toContain('Today   ✓ 3   ✗ 1')
    expect(t.setToolTip).toHaveBeenLastCalledWith('ChronosUI — ✓3 ✗1')
  })

  it('wires a recent-failure click through onOpenJob', async () => {
    const { TrayCtor } = fakeTray()
    const { built, Menu } = fakeMenu()
    const onOpenJob = vi.fn()
    const failedSummary = summary({
      failedToday: 1,
      failures: [
        {
          jobId: 42,
          jobName: 'Nightly',
          result: 'failure',
          exitCode: 1,
          durationMs: 10,
          startedAt: 0
        }
      ],
      failuresTotal: 1
    })
    createTray({
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      TrayCtor,
      Menu,
      iconPath: '/x/icon.png',
      getSummary: async () => failedSummary,
      onOpenJob
    })
    await flush()
    const last = built[built.length - 1]
    last.items.find((i) => i.label.startsWith('Nightly'))!.click!()
    expect(onOpenJob).toHaveBeenCalledWith(42)
  })

  it('applyRunEvent triggers a refresh on "finished" and "jobsChanged", not on "started"/"output"', async () => {
    const { TrayCtor } = fakeTray()
    const { Menu } = fakeMenu()
    const getSummary = vi.fn(async () => summary())
    const handle = createTray({
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      TrayCtor,
      Menu,
      iconPath: '/x/icon.png',
      getSummary
    })
    await flush()
    const callsAfterInit = getSummary.mock.calls.length

    handle.applyRunEvent({
      kind: 'started',
      jobId: 1,
      runId: 1,
      triggeredBy: 'manual',
      startedAt: 0
    })
    handle.applyRunEvent({ kind: 'output', runId: 1, stream: 'stdout', chunk: 'x' })
    await flush()
    expect(getSummary.mock.calls.length).toBe(callsAfterInit) // no-op kinds: no extra fetch

    handle.applyRunEvent({ kind: 'finished', runId: 1, result: 'success', exitCode: 0, endedAt: 0 })
    await flush()
    expect(getSummary.mock.calls.length).toBe(callsAfterInit + 1)

    handle.applyRunEvent({ kind: 'jobsChanged' })
    await flush()
    expect(getSummary.mock.calls.length).toBe(callsAfterInit + 2)
  })

  it('refresh() is re-entrant-safe: overlapping calls join the in-flight fetch instead of firing twice', async () => {
    const { TrayCtor } = fakeTray()
    const { Menu } = fakeMenu()
    let resolveFetch: (() => void) | undefined
    const getSummary = vi.fn(
      () =>
        new Promise<DashboardSummary>((resolve) => {
          resolveFetch = () => resolve(summary())
        })
    )
    const handle = createTray({
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      TrayCtor,
      Menu,
      iconPath: '/x/icon.png',
      getSummary
    })
    // The constructor already kicked off one in-flight refresh (getSummary is still pending).
    const callsAfterInit = getSummary.mock.calls.length
    const p1 = handle.refresh()
    const p2 = handle.refresh()
    expect(getSummary.mock.calls.length).toBe(callsAfterInit) // joined, no new fetch started
    resolveFetch?.()
    await Promise.all([p1, p2])
  })

  it('setTitle is called on darwin and not on other platforms', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const { t, TrayCtor } = fakeTray()
      const { Menu } = fakeMenu()
      createTray({
        onOpen: vi.fn(),
        onQuit: vi.fn(),
        TrayCtor,
        Menu,
        iconPath: '/x/icon.png',
        getSummary: async () => summary()
      })
      await flush()
      expect(t.setTitle).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }

    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { t, TrayCtor } = fakeTray()
      const { Menu } = fakeMenu()
      createTray({
        onOpen: vi.fn(),
        onQuit: vi.fn(),
        TrayCtor,
        Menu,
        iconPath: '/x/icon.png',
        getSummary: async () => summary()
      })
      await flush()
      expect(t.setTitle).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('attaches a menu-will-show listener that triggers a refresh (rebuild-on-open, best effort)', async () => {
    const { TrayCtor } = fakeTray()
    const { built, Menu } = fakeMenu()
    const getSummary = vi.fn(async () => summary())
    createTray({
      onOpen: vi.fn(),
      onQuit: vi.fn(),
      TrayCtor,
      Menu,
      iconPath: '/x/icon.png',
      getSummary
    })
    await flush()
    const last = built[built.length - 1]
    expect(last.on).toHaveBeenCalledWith('menu-will-show', expect.any(Function))
    const callsBefore = getSummary.mock.calls.length
    const onMenuWillShow = last.on.mock.calls[0][1] as () => void
    onMenuWillShow()
    await flush()
    expect(getSummary.mock.calls.length).toBe(callsBefore + 1)
  })
})

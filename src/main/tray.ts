// SPDX-License-Identifier: Apache-2.0
import { Tray, Menu } from 'electron'
import type { DashboardSummary } from './services/dashboard.service'
import type { RunEvent } from '../shared/ipc-contract'
import {
  buildTrayMenuItems,
  buildTrayTitle,
  buildTrayTooltip,
  type TrayMenuItemTemplate
} from './tray-menu'

export interface TrayLike {
  (iconPath: string): {
    setToolTip(s: string): void
    /** macOS-only (Electron `@platform darwin`) — guarded by `process.platform` at the call site,
     *  so a fake test double never needs to implement it. */
    setTitle?(s: string): void
    setContextMenu(m: unknown): void
    on(ev: string, cb: () => void): void
    destroy(): void
  }
}
export interface MenuLike {
  /** Returns `unknown` (not `Electron.Menu`) deliberately: interface methods are checked
   *  bivariantly, so keeping the return type opaque here — same as the pre-existing contract —
   *  avoids coupling this injectable seam to Electron's Menu type. createTray casts narrowly where
   *  it needs the optional `on('menu-will-show', …)` instance event. */
  buildFromTemplate(tpl: TrayMenuItemTemplate[]): unknown
}
export interface TrayDeps {
  onOpen: () => void
  onQuit: () => void
  iconPath: string
  TrayCtor?: TrayLike
  Menu?: MenuLike
  /** Dashboard summary source (Task 5's dashboard.service.ts, via bootstrap.ts's
   *  `deps.dashboardSummary`). Optional so the pre-Dashboard test double keeps working unchanged —
   *  defaults to "no data yet", which renders the same bare Open/Quit menu the tray always had. */
  getSummary?: () => Promise<DashboardSummary>
  /** Opens the main window to a failed job (see TrayMenuCallbacks.onOpenJob in tray-menu.ts for
   *  why this doesn't deep-link into run history). Defaults to a no-op. */
  onOpenJob?: (jobId: number) => void
}
export interface TrayHandle {
  destroy(): void
  /** Re-fetches the dashboard summary and rebuilds the menu/tooltip/title. Re-entrant: an overlapping
   *  call joins the in-flight one instead of firing a second dashboardSummary() round-trip (same
   *  guard as the renderer's dashboard.store.ts). */
  refresh(): Promise<void>
  /** Wire this up as another RunEvent consumer alongside the renderer's scheduleStore/dashboardStore
   *  fan-out (src/renderer/src/main.ts) — same filter dashboard.store.ts's applyRunEvent uses:
   *  only 'finished' (a run's outcome can move today's counts/failures) and 'jobsChanged' (jobs
   *  added/removed/rescheduled can move the upcoming projection) trigger a refresh. 'started' /
   *  'output' carry nothing the summary reflects. */
  applyRunEvent(e: RunEvent): void
}

interface MenuInstanceLike {
  on?(event: 'menu-will-show', cb: () => void): void
}

/** Build the system tray (Plan 7) + Dashboard summary (v0.4.0). Injectable so it unit-tests
 *  without a display. */
export function createTray(deps: TrayDeps): TrayHandle {
  const Ctor = deps.TrayCtor ?? ((p: string) => new Tray(p) as unknown as ReturnType<TrayLike>)
  const M = deps.Menu ?? Menu
  const getSummary = deps.getSummary ?? (async () => null as unknown as DashboardSummary)
  const onOpenJob = deps.onOpenJob ?? (() => {})
  const tray = Ctor(deps.iconPath)

  function render(summary: DashboardSummary | null): void {
    tray.setToolTip(buildTrayTooltip(summary))
    if (process.platform === 'darwin' && typeof tray.setTitle === 'function') {
      tray.setTitle(buildTrayTitle(summary))
    }
    const items = buildTrayMenuItems(summary, {
      onOpen: deps.onOpen,
      onQuit: deps.onQuit,
      onOpenJob
    })
    const menu = M.buildFromTemplate(items)
    tray.setContextMenu(menu)
    // Best-effort extra freshness (task: "rebuild on menu open if the framework supports it").
    // Electron's Menu instances emit 'menu-will-show' right before display; the primary refresh
    // path is still RunEvent-driven (applyRunEvent below) — this just catches anything missed
    // (e.g. the app was quiet for a while). A fresh listener is attached per built menu instance,
    // so nothing accumulates across refreshes.
    ;(menu as MenuInstanceLike).on?.('menu-will-show', () => {
      void refresh()
    })
  }

  let inFlight: Promise<void> | null = null
  function refresh(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const summary = await getSummary()
        render(summary)
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  // Synchronous placeholder render (no data yet) so the tray has a working menu the instant it's
  // created, then layer in the real dashboard summary asynchronously.
  render(null)
  void refresh()

  tray.on('click', () => deps.onOpen())

  return {
    destroy: () => tray.destroy(),
    refresh,
    applyRunEvent: (e) => {
      if (e.kind === 'finished' || e.kind === 'jobsChanged') void refresh()
    }
  }
}

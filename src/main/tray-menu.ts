// SPDX-License-Identifier: Apache-2.0
import type { DashboardSummary } from './services/dashboard.service'
import { TRAY_RECENT_FAILURES_LIMIT } from '../shared/dashboard-limits'

/** `HH:MM` (24h, zero-padded) for an epoch-ms timestamp in local time. Deliberately duplicated
 *  from src/renderer/src/lib/format.ts's `hhmm` (not imported): tsconfig.node.json's `include`
 *  stops at src/main + src/preload + src/shared, so main-process code can't reach into
 *  src/renderer without breaking that project boundary — the same boundary dashboard-limits.ts's
 *  own header comment documents in the other direction. */
function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface TrayMenuItemTemplate {
  label: string
  enabled?: boolean
  click?: () => void
  type?: 'separator'
}

export interface TrayMenuCallbacks {
  onOpen: () => void
  onQuit: () => void
  /** Opens the main window to a failed run's job. Deep-nav (jumping straight to the run-history
   *  row) isn't wired in v0.3.0's architecture (no main→renderer navigation IPC channel exists
   *  yet, and the renderer router uses in-memory history with no main-driven push) — opening the
   *  window is enough: it lands on the Dashboard, which already shows today's failures. */
  onOpenJob: (jobId: number) => void
}

/** Builds the Tray context-menu template from a DashboardSummary. Pure + Electron-free so it unit
 *  tests without a display (mirrors the createTray design note in tray.ts). `summary === null`
 *  covers the brief window before the first async dashboardSummary() call resolves — the menu
 *  falls back to just Open/Quit, same as the pre-Dashboard tray. */
export function buildTrayMenuItems(
  summary: DashboardSummary | null,
  callbacks: TrayMenuCallbacks
): TrayMenuItemTemplate[] {
  const items: TrayMenuItemTemplate[] = []

  if (summary) {
    items.push({
      label: `Today   ✓ ${summary.succeededToday}   ✗ ${summary.failedToday}`,
      enabled: false
    })
    items.push({ label: '', type: 'separator' })

    const shown = summary.failures.slice(0, TRAY_RECENT_FAILURES_LIMIT)
    if (shown.length === 0) {
      // Exact copy of DashboardView.vue's zero-state ("No failures today ✓") — same sensibility,
      // same wording.
      items.push({ label: 'No failures today ✓', enabled: false })
    } else {
      for (const f of shown) {
        items.push({
          label: `${f.jobName} — ${hhmm(f.startedAt)}`,
          click: () => callbacks.onOpenJob(f.jobId)
        })
      }
      const remaining = summary.failuresTotal - shown.length
      if (remaining > 0) {
        items.push({ label: `+${remaining} more…`, click: callbacks.onOpen })
      }
    }
    items.push({ label: '', type: 'separator' })

    const next = summary.upcoming[0]
    items.push(
      next
        ? { label: `Next: ${next.jobName} — ${hhmm(next.nextRunAt)}`, enabled: false }
        : { label: 'No upcoming runs', enabled: false } // exact copy of DashboardView.vue's zero-state
    )
    items.push({ label: '', type: 'separator' })
  }

  items.push({ label: 'Open ChronosUI', click: callbacks.onOpen })
  items.push({ label: 'Quit', click: callbacks.onQuit })
  return items
}

/** Compact "✓N ✗N" status string — quiet (empty string) whenever there are zero failures today,
 *  mirroring DashboardView.vue's own "only draw the eye when something's wrong" convention (its
 *  Failed tile only gets the `.danger` accent class when `failedToday > 0`; a clean day renders
 *  identically to every other tile). Shared by both the tray title (macOS, next to the icon) and
 *  the tooltip suffix so the two surfaces never disagree. */
export function buildTrayStatusText(summary: DashboardSummary | null): string {
  if (!summary || summary.failedToday === 0) return ''
  return `✓${summary.succeededToday} ✗${summary.failedToday}`
}

/** macOS-only text rendered next to the tray icon itself (Tray.setTitle). Same quiet-by-default
 *  rule as buildTrayStatusText — empty when there's nothing to flag. */
export function buildTrayTitle(summary: DashboardSummary | null): string {
  return buildTrayStatusText(summary)
}

/** Hover tooltip — always has SOME text (unlike the title, this is the only status surface on
 *  platforms without Tray.setTitle, e.g. Windows), but only appends the compact status when
 *  there's a failure to report; a clean day just reads "ChronosUI". */
export function buildTrayTooltip(summary: DashboardSummary | null): string {
  const status = buildTrayStatusText(summary)
  return status ? `ChronosUI — ${status}` : 'ChronosUI'
}

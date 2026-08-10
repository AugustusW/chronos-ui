// SPDX-License-Identifier: Apache-2.0
import { Notification } from 'electron'
import type { RunEvent } from '../../shared/ipc-contract'
import type { RunOutcomeRow } from '../db/repositories'

/** How many rows to fetch per poll tick — generous headroom over any realistic burst (a systemic
 *  failure hitting every job scheduled at the same minute), while still bounding a pathological
 *  query. Mirrors the defensive-limit convention in shared/dashboard-limits.ts. */
const POLL_LIMIT = 50

/** `HH:MM` (24h, zero-padded) — deliberately duplicated from tray-menu.ts's own copy of the
 *  renderer's `hhmm` (see that file's doc comment): same main/renderer project-boundary reason. */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export type ScheduledFailure = RunOutcomeRow & { result: 'failure' | 'timeout'; triggeredBy: 'schedule' }

/** Mirrors schedmgr's notifyAfterRun (schedmgr/notify.go, the Telegram notifier's own failure
 *  decision): "Called only for non-success, schedule-triggered runs" — a manually-triggered run's
 *  outcome is already visible in the app (live streaming output while it runs), so it doesn't also
 *  need a system notification; only a background/scheduled run failing while nobody's watching does.
 *  'failure' and 'timeout' both count as a failure (same FAILED set as dashboard.repository.ts /
 *  notify.go's `result != "success"`) — success and any still-running row never do. */
export function isNotifyWorthy(row: RunOutcomeRow): row is ScheduledFailure {
  return row.triggeredBy === 'schedule' && (row.result === 'failure' || row.result === 'timeout')
}

export interface FailureSelection {
  toNotify: ScheduledFailure[]
  nextSinceTs: number
}

/** Pure decision function: given the raw run outcomes returned since the last watermark (any
 *  result/trigger — the repository query intentionally doesn't pre-filter, see RunOutcomeRow's doc
 *  comment), pick the ones worth a native notification and compute the next watermark. `rows` are
 *  assumed already bounded to `startedAt > sinceTs` by the caller's query (dashboard.repository.ts's
 *  listRunOutcomesSince uses `gt`); the `> sinceTs` check here is belt-and-suspenders against the
 *  exact boundary row being double-counted if a caller ever passes an unbounded/wider `rows` list.
 *  The watermark advances over EVERY returned row (not just notify-worthy ones) so manual-run and
 *  success rows still move the polling window forward. */
export function selectNewFailures(rows: RunOutcomeRow[], sinceTs: number): FailureSelection {
  const toNotify = rows.filter((r): r is ScheduledFailure => r.startedAt.getTime() > sinceTs && isNotifyWorthy(r))
  const nextSinceTs = rows.reduce((max, r) => Math.max(max, r.startedAt.getTime()), sinceTs)
  return { toNotify, nextSinceTs }
}

function singleBody(f: ScheduledFailure): string {
  const verb = f.result === 'timeout' ? 'timed out' : 'failed'
  const meta = [verb]
  if (f.result !== 'timeout' && f.exitCode != null) meta.push(`exit ${f.exitCode}`)
  meta.push(hhmm(f.startedAt))
  return meta.join(' · ')
}

function digestLine(f: ScheduledFailure): string {
  if (f.result === 'timeout') return `${f.jobName} — timeout ${hhmm(f.startedAt)}`
  if (f.exitCode != null) return `${f.jobName} — failure (exit ${f.exitCode}) ${hhmm(f.startedAt)}`
  return `${f.jobName} — failure ${hhmm(f.startedAt)}`
}

/** Builds the notification's title/body. Wording mirrors schedmgr/notify_format.go's own two
 *  shapes (formatImmediate for one failure, formatDigest for several) so native and Telegram read
 *  as the same product rather than two differently-worded alerts: a single new failure gets its own
 *  named notification (title = job name, matching Telegram's "{name} failed/timed out"); several new
 *  failures discovered in the SAME poll tick are bundled into one "N jobs failed" digest with a
 *  bullet per job (matching formatDigest's "• {name} — {outcome} {time}" lines) instead of firing N
 *  separate banners. This is deliberately NOT the same mechanism as Telegram's windowMin batching
 *  (see native-notify.test.ts's header comment / the PR description for the reasoning) — it's a
 *  same-tick bundle, not a time-delayed digest. */
export function formatFailureNotification(failures: ScheduledFailure[]): { title: string; body: string } {
  if (failures.length === 1) {
    const f = failures[0]
    return { title: f.jobName, body: singleBody(f) }
  }
  return {
    title: `${failures.length} jobs failed`,
    body: failures.map((f) => `• ${digestLine(f)}`).join('\n')
  }
}

/** Minimal seam over Electron's Notification so the service below unit-tests without a display —
 *  same injectable-adapter shape as tray.ts's TrayLike/MenuLike. */
export interface NativeNotifier {
  isSupported(): boolean
  show(opts: { title: string; body: string; onClick: () => void }): void
}

/** Real Electron-backed NativeNotifier (macOS/Windows; Notification.isSupported() gates Linux
 *  desktops without a notification daemon). Only ever invoked outside tests — see this file's
 *  header note in tray.ts about the same `import … from 'electron'` + injectable-default pattern. */
export function createElectronNotifier(): NativeNotifier {
  return {
    isSupported: () => Notification.isSupported(),
    show: ({ title, body, onClick }) => {
      const n = new Notification({ title, body })
      n.on('click', onClick)
      n.show()
    }
  }
}

export interface NativeNotifyDeps {
  listRunOutcomes: (since: Date, limit: number) => Promise<RunOutcomeRow[]>
  /** Reads the current "Native failure notifications" toggle (notify_settings.nativeEnabled) — read
   *  fresh on every check (not cached at construction) so a mid-session settings change takes effect
   *  immediately, same as Telegram's own settings read in notifyAfterRun. */
  getNativeEnabled: () => Promise<boolean>
  notifier: NativeNotifier
  /** Opens/focuses the main window on a notification click — same callback as the tray's
   *  onOpenJob/onOpen (index.ts passes the same showWin). No deep-nav for the same reason tray-menu.ts
   *  doesn't: no main→renderer navigation channel exists yet. */
  onOpen: () => void
  now?: () => Date
}

export interface NativeNotifyHandle {
  /** Wire this up as another RunEvent consumer alongside the tray's applyRunEvent (index.ts's
   *  onRunEvent fan-out) — same filter: only 'finished' (a manual run just completed — irrelevant to
   *  THIS service since isNotifyWorthy excludes manual runs, but jobsChanged is what actually surfaces
   *  scheduled runs, see below) and 'jobsChanged' (the DB file-watcher poll — this IS how a
   *  schedule-triggered run, which happens entirely outside Electron via cron/launchd invoking
   *  schedmgr directly, becomes visible to this process at all) trigger a check. */
  applyRunEvent(e: RunEvent): void
}

/** Detects newly-completed SCHEDULED failures and fires a native OS notification for them. Reuses
 *  dashboard.repository.ts's query layer (listRunOutcomesSince) — no separate SQL — and keeps every
 *  decision (which rows count as a failure, how to word the notification) in the pure functions
 *  above so they unit-test without Electron. */
export function createNativeNotifyService(deps: NativeNotifyDeps): NativeNotifyHandle {
  const nowFn = deps.now ?? (() => new Date())
  // Boot watermark: only failures that STARTED after this service was created are notify-worthy —
  // otherwise every launch would replay however many scheduled failures piled up while the app was
  // closed as a burst of banners. This is the native-only equivalent of Telegram's outbox being
  // drained continuously by its own always-on launchd flush entry (which runs independent of
  // whether ChronosUI is even open) — native notifications, by contrast, can only ever fire while
  // this process is running, so "since I started watching" is the correct floor.
  let sinceTs = nowFn().getTime()
  let inFlight: Promise<void> | null = null

  function checkNow(): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      try {
        const rows = await deps.listRunOutcomes(new Date(sinceTs), POLL_LIMIT)
        const { toNotify, nextSinceTs } = selectNewFailures(rows, sinceTs)
        sinceTs = nextSinceTs
        if (toNotify.length === 0) return
        // Gate AFTER computing the selection (not before the query) so the watermark still advances
        // while the toggle is off — flipping it back on later doesn't replay the gap as a burst.
        if (!(await deps.getNativeEnabled())) return
        if (!deps.notifier.isSupported()) return
        const { title, body } = formatFailureNotification(toNotify)
        deps.notifier.show({ title, body, onClick: deps.onOpen })
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  return {
    applyRunEvent: (e) => {
      if (e.kind === 'finished' || e.kind === 'jobsChanged') void checkNow()
    }
  }
}

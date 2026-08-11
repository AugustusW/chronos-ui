// SPDX-License-Identifier: Apache-2.0
const DOW = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `HH:MM` (24h, zero-padded) for an epoch-ms timestamp in local time. Shared by the dashboard's
 *  failure rows and upcomingLabel so the two don't drift (review T7 dedup). */
export function hhmm(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Local-calendar-day difference between two epoch-ms timestamps (`a` minus `b`), independent of
 *  the (possibly non-24h, DST-crossing) ms delta between them. */
function calendarDayDiff(a: number, b: number): number {
  const da = new Date(a)
  const db = new Date(b)
  const utcA = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())
  const utcB = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate())
  return Math.round((utcA - utcB) / 86_400_000)
}

export function cronToHuman(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return expr
  const [min, hr, dom, mon, dow] = f
  const at = (h: string, m: string): string => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  const isNum = (s: string): boolean => /^\d+$/.test(s)
  if (min.startsWith('*/') && hr === '*' && dom === '*' && mon === '*' && dow === '*')
    return `Every ${min.slice(2)} minutes`
  if (isNum(min) && hr.startsWith('*/') && dom === '*' && mon === '*' && dow === '*')
    return `Every ${hr.slice(2)} hours`
  if (isNum(min) && isNum(hr) && dom === '*' && mon === '*' && dow === '*')
    return `Daily at ${at(hr, min)}`
  if (isNum(min) && isNum(hr) && dom === '*' && mon === '*' && isNum(dow) && +dow <= 6)
    return `${DOW[+dow]} at ${at(hr, min)}`
  return expr
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`
}

/** Formats a future `ts` (epoch ms) relative to `now` for the dashboard's upcoming-runs list
 *  (spec §3, corrected 2026-08-01 final review #3/T7 — the original spec's binary same-day/
 *  tomorrow split mislabeled anything more than 1 calendar day out as "tomorrow"). Rules, in
 *  order: under an hour away → "in N min"; later the same calendar day → "HH:MM"; exactly one
 *  calendar day out → "tomorrow HH:MM"; 2–6 calendar days out → short weekday + "HH:MM" (e.g.
 *  "Mon 09:00"); 7+ calendar days out → short date + "HH:MM" (e.g. "Sep 1 08:15"). */
export function upcomingLabel(ts: number, now: number): string {
  const diffMs = ts - now
  if (diffMs < 60 * 60_000) return `in ${Math.max(0, Math.round(diffMs / 60_000))} min`
  const dayDiff = calendarDayDiff(ts, now)
  if (dayDiff === 0) return hhmm(ts)
  if (dayDiff === 1) return `tomorrow ${hhmm(ts)}`
  if (dayDiff < 7) return `${DOW_SHORT[new Date(ts).getDay()]} ${hhmm(ts)}`
  const shortDate = new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${shortDate} ${hhmm(ts)}`
}

/** Derive a short display name from a shell command string.
 *  Takes the first whitespace-delimited token and strips any leading path,
 *  e.g. `/usr/bin/pg_dump assistant | gzip` → `pg_dump`.
 *  Falls back to `'job'` if the result would be empty.
 */
export function deriveJobName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split('/').at(-1) ?? ''
  return base || 'job'
}

export type DateRangePreset = 'today' | '7d' | '30d' | 'all'

/** Resolves a Run History date-range PRESET (v0.4.0, RunHistoryView.vue) to a `since` epoch-ms
 *  lower bound — `undefined` for 'all' (no bound at all, so the search filter is simply omitted).
 *  'today' = local midnight, same definition as dashboard.service.ts's localMidnight, reimplemented
 *  here rather than imported: main-process code can't cross into the renderer bundle (same
 *  project-boundary reasoning as tray-menu.ts's own duplicated `hhmm`). */
export function resolveDateRangePreset(preset: DateRangePreset, now: number = Date.now()): number | undefined {
  if (preset === 'all') return undefined
  if (preset === 'today') {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = preset === '7d' ? 7 : 30
  return now - days * 86_400_000
}

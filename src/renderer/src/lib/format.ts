// SPDX-License-Identifier: Apache-2.0
const DOW = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

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

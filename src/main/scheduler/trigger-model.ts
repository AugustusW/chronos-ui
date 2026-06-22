// SPDX-License-Identifier: Apache-2.0

// ChronosUI's normalized Windows trigger descriptor (spec §7: scheduleExpr may be
// a "normalized Task Scheduler trigger" — Windows does NOT use cron). A compact,
// parseable mini-format mapping 1:1 onto the trigger types New-ScheduledTaskTrigger
// builds natively. Supported v1 kinds:
//   daily HH:MM | weekly MON,WED,FRI HH:MM | minutes N | hourly N |
//   onlogon | onstart | once YYYY-MM-DDTHH:MM
// (monthly is a documented v1 gap — New-ScheduledTaskTrigger has no -Monthly; it
// needs a raw CIM trigger and is deferred.)

export type WeekDay = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'

export type TriggerSpec =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; days: WeekDay[]; at: string }
  | { kind: 'minutes'; every: number }
  | { kind: 'hourly'; every: number }
  | { kind: 'onlogon' }
  | { kind: 'onstart' }
  | { kind: 'once'; at: string }

const WEEKDAYS: WeekDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const WEEKDAY_FULL: Record<WeekDay, string> = {
  MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday'
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const ONCE_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)$/

function assertTime(at: string): void {
  if (!HHMM_RE.test(at)) throw new Error(`trigger: bad time ${at} (want HH:MM)`)
}

export function parseTriggerDescriptor(s: string): TriggerSpec {
  const [head, ...rest] = s.trim().split(/\s+/)
  switch (head) {
    case 'daily': {
      if (rest.length !== 1) throw new Error(`trigger: 'daily' wants HH:MM`)
      assertTime(rest[0])
      return { kind: 'daily', at: rest[0] }
    }
    case 'weekly': {
      if (rest.length !== 2) throw new Error(`trigger: 'weekly' wants DAYS HH:MM`)
      const days = rest[0].split(',').map((d) => d.toUpperCase())
      for (const d of days) if (!WEEKDAYS.includes(d as WeekDay)) throw new Error(`trigger: bad day ${d}`)
      assertTime(rest[1])
      // keep canonical MON..SUN order
      const ordered = WEEKDAYS.filter((w) => days.includes(w))
      return { kind: 'weekly', days: ordered, at: rest[1] }
    }
    case 'minutes': {
      const n = Number(rest[0])
      if (rest.length !== 1 || !Number.isInteger(n) || n < 1) throw new Error(`trigger: 'minutes' wants a positive integer`)
      return { kind: 'minutes', every: n }
    }
    case 'hourly': {
      const n = Number(rest[0])
      if (rest.length !== 1 || !Number.isInteger(n) || n < 1) throw new Error(`trigger: 'hourly' wants a positive integer`)
      return { kind: 'hourly', every: n }
    }
    case 'onlogon':
      if (rest.length !== 0) throw new Error(`trigger: 'onlogon' takes no args`)
      return { kind: 'onlogon' }
    case 'onstart':
      if (rest.length !== 0) throw new Error(`trigger: 'onstart' takes no args`)
      return { kind: 'onstart' }
    case 'once': {
      if (rest.length !== 1 || !ONCE_RE.test(rest[0])) throw new Error(`trigger: 'once' wants YYYY-MM-DDTHH:MM`)
      return { kind: 'once', at: rest[0] }
    }
    default:
      throw new Error(`trigger: unknown kind ${head}`)
  }
}

export function triggerSpecToDescriptor(spec: TriggerSpec): string {
  switch (spec.kind) {
    case 'daily': return `daily ${spec.at}`
    case 'weekly': return `weekly ${spec.days.join(',')} ${spec.at}`
    case 'minutes': return `minutes ${spec.every}`
    case 'hourly': return `hourly ${spec.every}`
    case 'onlogon': return 'onlogon'
    case 'onstart': return 'onstart'
    case 'once': return `once ${spec.at}`
  }
}

// Render a PowerShell New-ScheduledTaskTrigger expression. minutes/hourly anchor a
// -Once trigger at (Get-Date) with an indefinite RepetitionInterval (PowerShell
// evaluates Get-Date at run time).
export function triggerSpecToPwsh(spec: TriggerSpec): string {
  switch (spec.kind) {
    case 'daily':
      return `New-ScheduledTaskTrigger -Daily -At '${spec.at}'`
    case 'weekly':
      return `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${spec.days.map((d) => WEEKDAY_FULL[d]).join(',')} -At '${spec.at}'`
    case 'minutes':
      return `New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${spec.every})`
    case 'hourly':
      return `New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours ${spec.every})`
    case 'onlogon':
      return 'New-ScheduledTaskTrigger -AtLogOn'
    case 'onstart':
      return 'New-ScheduledTaskTrigger -AtStartup'
    case 'once':
      return `New-ScheduledTaskTrigger -Once -At '${spec.at}'`
  }
}

// Projected JSON shape of a Task Scheduler trigger (see the adapter's list script).
export interface CimTrigger {
  CimClass?: string | null
  StartBoundary?: string | null
  DaysOfWeek?: number | null
  Repetition?: { Interval?: string | null } | null
}

// Best-effort read-back for DISPLAY of pre-existing (non-ChronosUI) tasks. Managed
// tasks NEVER use this (they read the exact stashed descriptor). Unsupported triggers
// return lossy:true with a raw label so the UI flags "not editable here" rather than
// misrepresenting the schedule (architect D3). Display-only — a miss never drives a write.
export function cimTriggerToDescriptor(t: CimTrigger): { descriptor: string; lossy: boolean } {
  const cls = t.CimClass ?? ''
  const at = hhmmFromBoundary(t.StartBoundary)
  switch (cls) {
    case 'MSFT_TaskDailyTrigger':
      return at ? { descriptor: `daily ${at}`, lossy: false } : { descriptor: 'daily (unknown time)', lossy: true }
    case 'MSFT_TaskWeeklyTrigger': {
      const days = decodeDaysOfWeek(t.DaysOfWeek ?? 0)
      return at && days.length
        ? { descriptor: `weekly ${days.join(',')} ${at}`, lossy: false }
        : { descriptor: 'weekly (unknown)', lossy: true }
    }
    case 'MSFT_TaskLogonTrigger':
      return { descriptor: 'onlogon', lossy: false }
    case 'MSFT_TaskBootTrigger':
      return { descriptor: 'onstart', lossy: false }
    case 'MSFT_TaskTimeTrigger': {
      const iv = t.Repetition?.Interval ?? null
      const m = iv ? /^PT(\d+)M$/.exec(iv) : null
      const h = iv ? /^PT(\d+)H$/.exec(iv) : null
      if (m) return { descriptor: `minutes ${Number(m[1])}`, lossy: false }
      if (h) return { descriptor: `hourly ${Number(h[1])}`, lossy: false }
      if (!iv) {
        const once = onceFromBoundary(t.StartBoundary)
        return once ? { descriptor: `once ${once}`, lossy: false } : { descriptor: 'once (unknown time)', lossy: true }
      }
      return { descriptor: 'time trigger (unsupported)', lossy: true }
    }
    default:
      return { descriptor: cls ? `${cls} (unsupported)` : 'unknown trigger', lossy: true }
  }
}

function hhmmFromBoundary(b: string | null | undefined): string | null {
  if (!b) return null
  const m = /T([01]\d|2[0-3]):([0-5]\d)/.exec(b)
  return m ? `${m[1]}:${m[2]}` : null
}

// Extract 'YYYY-MM-DDTHH:MM' from a StartBoundary like '2026-07-01T08:00:00'.
function onceFromBoundary(b: string | null | undefined): string | null {
  if (!b) return null
  const m = /^(\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d))/.exec(b)
  return m ? m[1] : null
}

// MSFT_TaskWeeklyTrigger.DaysOfWeek bitmask: Sun=1,Mon=2,Tue=4,Wed=8,Thu=16,Fri=32,Sat=64.
function decodeDaysOfWeek(mask: number): WeekDay[] {
  const bits: [number, WeekDay][] = [[2, 'MON'], [4, 'TUE'], [8, 'WED'], [16, 'THU'], [32, 'FRI'], [64, 'SAT'], [1, 'SUN']]
  return bits.filter(([b]) => (mask & b) !== 0).map(([, d]) => d)
}

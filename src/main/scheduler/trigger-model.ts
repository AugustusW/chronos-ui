// SPDX-License-Identifier: Apache-2.0

// PowerShell-specific half of the Windows trigger model. The descriptor grammar itself
// (parse / validate / describe) lives in src/shared/trigger-validation.ts because the job editor
// must reject a bad schedule before submitting it, and a second copy of the rules in the renderer
// is precisely how the "editor asks for cron, adapter accepts descriptors" defect arose.
//
// Re-exported here so main-process callers (next-run.ts, task-scheduler.adapter.ts, scheduler/index.ts)
// keep importing from one place.

import { WEEKDAY_FULL, type TriggerSpec, type WeekDay } from '../../shared/trigger-validation'

export {
  WEEKDAYS,
  WEEKDAY_FULL,
  TRIGGER_DESCRIPTOR_EXAMPLE,
  parseTriggerDescriptor,
  triggerSpecToDescriptor,
  validateTriggerDescriptor,
  describeTriggerDescriptor
} from '../../shared/trigger-validation'
export type { TriggerSpec, WeekDay } from '../../shared/trigger-validation'

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

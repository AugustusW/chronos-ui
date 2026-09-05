// SPDX-License-Identifier: Apache-2.0
//
// ChronosUI's normalized Windows trigger descriptor: the mini-format that maps 1:1 onto the
// trigger types New-ScheduledTaskTrigger builds natively. Windows does NOT use cron.
//
//   daily HH:MM | weekly MON,WED,FRI HH:MM | minutes N | hourly N |
//   onlogon | onstart | once YYYY-MM-DDTHH:MM
//
// (monthly is a documented v1 gap — New-ScheduledTaskTrigger has no -Monthly.)
//
// This lives in shared/ rather than main/scheduler/ for one reason: the job editor has to reject a
// bad schedule before it is submitted, and the alternative is a second copy of these rules written
// in the renderer. A second copy is exactly how the defect this fixes came about — the editor
// asked for cron while the Windows adapter accepted only descriptors, because nothing tied the two
// statements together. Both sides now import this file.
//
// Pure: no node, no electron, no DOM. Everything PowerShell-specific stays in
// main/scheduler/trigger-model.ts.

export type WeekDay = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'

export type TriggerSpec =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; days: WeekDay[]; at: string }
  | { kind: 'minutes'; every: number }
  | { kind: 'hourly'; every: number }
  | { kind: 'onlogon' }
  | { kind: 'onstart' }
  | { kind: 'once'; at: string }

export const WEEKDAYS: WeekDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
export const WEEKDAY_FULL: Record<WeekDay, string> = {
  MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday'
}

/** One canonical example, reused by the validator message and the editor's placeholder so the two
 *  can never drift into suggesting different things. */
export const TRIGGER_DESCRIPTOR_EXAMPLE = 'daily 03:00'

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const ONCE_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)$/
/** 5 or 6 whitespace-separated fields of cron-ish characters — enough to recognise the mistake. */
const CRONISH_RE = /^\S+(\s+\S+){4,5}$/

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

const ACCEPTED =
  'daily HH:MM, weekly MON,WED HH:MM, hourly N, minutes N, onlogon, onstart, or once YYYY-MM-DDTHH:MM'

/**
 * `null` when `s` is a valid descriptor, otherwise a message written for the person typing it.
 *
 * A cron expression gets named as such. The parser's own error for `0 3 * * *` is
 * "trigger: unknown kind 0" — the first field of the user's cron line handed back as though it were
 * a typo, which tells them nothing about what went wrong or what to do instead.
 */
export function validateTriggerDescriptor(s: string): string | null {
  const t = s.trim()
  if (!t) return 'Enter a schedule.'
  try {
    parseTriggerDescriptor(t)
    return null
  } catch (err) {
    const raw = (err as Error).message.replace(/^trigger: /, '')
    if (CRONISH_RE.test(t)) {
      return `That looks like a cron expression. This computer schedules with Windows Task Scheduler, which uses ${ACCEPTED} — for example "${TRIGGER_DESCRIPTOR_EXAMPLE}".`
    }
    if (raw.startsWith('unknown kind')) return `Unrecognized schedule. Use ${ACCEPTED}.`
    return raw.charAt(0).toUpperCase() + raw.slice(1) + '.'
  }
}

function joinDays(days: WeekDay[]): string {
  const names = days.map((d) => WEEKDAY_FULL[d])
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Plain-language rendering for the editor's preview, or `null` while the field is mid-edit.
 *  Never throws: a preview that crashes on a half-typed schedule is worse than no preview. */
export function describeTriggerDescriptor(s: string): string | null {
  let spec: TriggerSpec
  try {
    spec = parseTriggerDescriptor(s)
  } catch {
    return null
  }
  switch (spec.kind) {
    case 'daily': return `Every day at ${spec.at}`
    case 'weekly': return `Every ${joinDays(spec.days)} at ${spec.at}`
    case 'hourly': return spec.every === 1 ? 'Every hour' : `Every ${spec.every} hours`
    case 'minutes': return spec.every === 1 ? 'Every minute' : `Every ${spec.every} minutes`
    case 'onlogon': return 'When you sign in'
    case 'onstart': return 'When the computer starts'
    case 'once': {
      const [date, time] = spec.at.split('T')
      return `Once, on ${date} at ${time}`
    }
  }
}

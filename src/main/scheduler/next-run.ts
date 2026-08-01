// SPDX-License-Identifier: Apache-2.0
import { Cron } from 'croner'
import { parseTriggerDescriptor, type TriggerSpec, type WeekDay } from './trigger-model'

const DOW_NUM: Record<WeekDay, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

/** Next fire time for a job's scheduleExpr, or null when the expression is event-based
 *  (onlogon/onstart), already exhausted (past `once`), or unparseable. Never throws —
 *  a bad expr must not take down the whole dashboard summary (spec §2). */
export function nextRunAt(source: 'native_cron' | 'native_task', scheduleExpr: string, now: Date): Date | null {
  if (source === 'native_cron') return nextCron(scheduleExpr, now)
  return nextTrigger(scheduleExpr, now)
}

function nextCron(expr: string, now: Date): Date | null {
  let cron: Cron | undefined
  try {
    cron = new Cron(expr)
    return cron.nextRun(now)
  } catch {
    return null
  } finally {
    // Constructed without a callback croner should not arm a timer, but its docs leave room for
    // ambiguity — stop() unconditionally so a throwaway instance can never leak one (architect LOW-1).
    cron?.stop()
  }
}

function atTime(base: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

function nextTrigger(expr: string, now: Date): Date | null {
  let spec: TriggerSpec
  try {
    spec = parseTriggerDescriptor(expr)
  } catch {
    return null
  }
  switch (spec.kind) {
    case 'daily': {
      const today = atTime(now, spec.at)
      if (today > now) return today
      const t = new Date(today)
      t.setDate(t.getDate() + 1)
      return t
    }
    case 'weekly': {
      const targets = new Set(spec.days.map((d) => DOW_NUM[d]))
      for (let add = 0; add <= 7; add++) {
        const cand = new Date(now)
        cand.setDate(cand.getDate() + add)
        const at = atTime(cand, spec.at)
        if (targets.has(at.getDay()) && at > now) return at
      }
      return null
    }
    case 'minutes':
      return new Date(now.getTime() + spec.every * 60_000)
    case 'hourly':
      return new Date(now.getTime() + spec.every * 3_600_000)
    case 'once': {
      const at = new Date(spec.at)
      return at > now ? at : null
    }
    case 'onlogon':
    case 'onstart':
      return null
  }
}

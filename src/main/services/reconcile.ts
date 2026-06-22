// SPDX-License-Identifier: Apache-2.0
import type { Job } from '../db/schema'
import type { ParsedJob } from '../scheduler/types'
import type { JobListItem, ReconcileResult } from '../../shared/ipc-contract'

type DriftField = 'scheduleExpr' | 'command' | 'enabled'

function driftFields(dbJob: Job, native: ParsedJob): DriftField[] {
  const fields: DriftField[] = []
  if (dbJob.scheduleExpr !== native.scheduleExpr) fields.push('scheduleExpr')
  if (dbJob.command !== native.command) fields.push('command')
  if (dbJob.enabled !== native.enabled) fields.push('enabled')
  return fields
}

/**
 * Non-destructive reconcile (spec §4.4, design §5): classify native lines against DB jobs.
 * Pure — never mutates either source. Resolution is an explicit user action in the UI (Plan 6).
 */
export function reconcile(native: ParsedJob[], dbJobs: Job[], now: () => number = () => Date.now()): ReconcileResult {
  const byId = new Map(dbJobs.map((j) => [j.id, j]))
  const seen = new Set<number>()
  const items: JobListItem[] = []

  for (const p of native) {
    if (p.chronosId === null) {
      items.push({ status: 'unmanaged', native: p })
      continue
    }
    const dbJob = byId.get(p.chronosId)
    if (!dbJob) {
      items.push({ status: 'orphan_native', native: p }) // marker present but no DB row (partial delete / stale backup)
      continue
    }
    seen.add(p.chronosId)
    const fields = driftFields(dbJob, p)
    items.push(
      fields.length
        ? { status: 'drifted', job: dbJob, native: p, driftFields: fields }
        : { status: 'in_sync', job: dbJob, native: p }
    )
  }

  for (const j of dbJobs) {
    if (!seen.has(j.id)) items.push({ status: 'vanished', job: j })
  }

  return { items, generatedAt: now() }
}

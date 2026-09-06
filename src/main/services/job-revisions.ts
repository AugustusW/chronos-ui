// SPDX-License-Identifier: Apache-2.0
import type { Job } from '../db/schema'

/**
 * The job fields a revision tracks: everything the user configures, and `adopted` (which flips on
 * the adopt/unadopt round trip that is the ONLY way an adopted job's command can change — the
 * adapters refuse an in-place command edit on an adopted job).
 *
 * Deliberately excluded: `id`/`source`/`platform` (immutable), `createdAt`/`updatedAt` (bookkeeping),
 * and `lastRunAt`/`lastResult` — those two move every time a run finishes, and treating them as
 * config would fill the history with rows for edits nobody made.
 */
export const REVISION_TRACKED_FIELDS = [
  'name',
  'scheduleExpr',
  'command',
  'workingDir',
  'env',
  'timeoutSec',
  'category',
  'notifyOnFailure',
  'enabled',
  'adopted'
] as const

export type RevisionTrackedField = (typeof REVISION_TRACKED_FIELDS)[number]

/** The shape diffJobConfig needs: a full job row, or any object carrying the tracked fields. */
export type JobConfigLike = Pick<Job, RevisionTrackedField>

export interface JobConfigDiff {
  changedFields: string[]
  before: Record<string, unknown>
  after: Record<string, unknown>
}

/** Content comparison for `env`, the only tracked field that is an object. Reference equality (or
 *  JSON.stringify, which is key-order sensitive) would report a change every time the renderer
 *  re-sends an unchanged form, writing a phantom revision on each save. */
function envEqual(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (a === b) return true
  // null and {} are NOT equal: one means "no env configured", the other "configured, empty".
  if (a === null || b === null) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k])
}

function fieldEqual(field: RevisionTrackedField, a: unknown, b: unknown): boolean {
  if (field === 'env') {
    return envEqual(a as Record<string, string> | null, b as Record<string, string> | null)
  }
  return a === b
}

/**
 * Compare two job configurations and return only what changed, or `null` when nothing did.
 *
 * Returning `null` (rather than an empty diff) is what keeps callers honest: a revision row is
 * written if and only if this returns a value, so "no change" can never produce history noise.
 * `before`/`after` carry just the changed fields — a revision is a diff, not a snapshot.
 */
export function diffJobConfig(before: JobConfigLike, after: JobConfigLike): JobConfigDiff | null {
  const changedFields: string[] = []
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const field of REVISION_TRACKED_FIELDS) {
    const prev = before[field]
    const next = after[field]
    if (fieldEqual(field, prev, next)) continue
    changedFields.push(field)
    b[field] = prev
    a[field] = next
  }
  return changedFields.length ? { changedFields, before: b, after: a } : null
}

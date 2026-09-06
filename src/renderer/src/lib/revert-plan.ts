// SPDX-License-Identifier: Apache-2.0
import type { JobRevision, UpdateJobChanges } from '../../../shared/ipc-contract'

/** Fields a revert can restore through the ordinary jobs:update path. */
const UPDATE_FIELDS = [
  'name',
  'scheduleExpr',
  'command',
  'workingDir',
  'env',
  'timeoutSec',
  'category',
  'notifyOnFailure'
] as const

export interface RevertPlan {
  /** Old values to send through jobs:update. Empty when nothing is restorable that way. */
  changes: UpdateJobChanges
  /** Present when the revision changed `enabled`: that is not part of UpdateJobChanges, so it is
   *  restored with the enable/disable calls instead. */
  setEnabled?: boolean
  /**
   * Fields whose old value cannot be expressed through the current update contract, so a revert
   * would silently leave them as they are. Two cases:
   *  - `adopted`, which is changed by adopt/un-adopt, not by editing fields.
   *  - restoring an optional field to "not set": UpdateJobChanges types these as `string?`/`number?`,
   *    and an omitted key means "leave unchanged", so there is no way to say "clear this".
   * The caller MUST show these to the user. A revert that quietly restores three fields out of four
   * is worse than one that refuses, because the user believes the job is back to its old state.
   */
  unsupported: string[]
}

/** Work out what reverting to a revision's `before` values would actually do. Pure, so the honest
 *  answer — including what it cannot do — is testable without a window or an IPC bridge. */
export function revertPlan(revision: JobRevision): RevertPlan {
  const changes: UpdateJobChanges = {}
  const unsupported: string[] = []
  let setEnabled: boolean | undefined

  for (const field of revision.changedFields) {
    const old = revision.before[field]
    if (field === 'enabled') {
      setEnabled = old === true
      continue
    }
    if (!(UPDATE_FIELDS as readonly string[]).includes(field)) {
      unsupported.push(field)
      continue
    }
    if (old === null || old === undefined) {
      unsupported.push(field)
      continue
    }
    ;(changes as Record<string, unknown>)[field] = old
  }

  return setEnabled === undefined ? { changes, unsupported } : { changes, setEnabled, unsupported }
}

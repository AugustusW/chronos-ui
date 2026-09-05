// SPDX-License-Identifier: Apache-2.0

// ChronosUI stamps managed Task Scheduler tasks with a marker in the task's
// Description field (Task Scheduler has no custom-metadata slot — Description is
// the pragmatic, human-visible analog of crontab's `# chronos:<id>` comment).
// Managed-task Description format (newline-separated):
//   ChronosUI managed job
//   chronos:<id>
//   sched:<trigger descriptor>
//   exec:<base64 of the original Execute>     (adopted tasks only)
//   args:<base64 of the original Arguments>   (adopted tasks only)
//   desc:<base64 of the original Description> (adopted tasks only, omitted when it was empty)
// list() reads scheduleExpr straight back from `sched:` — exact, no lossy CIM
// trigger parsing for tasks we created (architect D3).

const CHRONOS_RE = /^chronos:(\d+)$/m
const SCHED_RE = /^sched:(.+)$/m
const EXEC_RE = /^exec:(.*)$/m
const ARGS_RE = /^args:(.*)$/m
const DESC_RE = /^desc:(.*)$/m

/** A Task Scheduler action, kept as its two real fields. Flattening them into one string is what
 *  forced un-adopt to rebuild everything as `cmd.exe /c …`, which changes how &, | and > behave
 *  and how the exit code propagates. */
export interface OriginalAction {
  execute: string
  args: string
}

export interface TaskMarker {
  chronosId: number
  scheduleDescriptor: string
  /** What the task ran before ChronosUI wrapped it. Absent on tasks ChronosUI created, and on
   *  tasks adopted by a build that predates this field. */
  original?: OriginalAction
  /** The Description the task had before the marker replaced it. Adopting overwrites the one field
   *  Task Scheduler gives a person to write in; without this, un-adopt hands the task back with
   *  ChronosUI's text where the owner's note used to be. */
  originalDescription?: string
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8')

/**
 * `original` is stored base64-encoded. The marker is parsed line by line and an argument may
 * contain a newline — the same multi-line hazard that broke the old stdin script delivery. The
 * three human-readable lines come first, because Description is where a person looks and Task
 * Scheduler offers nowhere else to put this.
 */
export function buildDescription(
  chronosId: number,
  scheduleDescriptor: string,
  original?: OriginalAction,
  originalDescription?: string
): string {
  const head = `ChronosUI managed job\nchronos:${chronosId}\nsched:${scheduleDescriptor}`
  if (!original) return head
  const desc = originalDescription ? `\ndesc:${b64(originalDescription)}` : ''
  return `${head}\nexec:${b64(original.execute)}\nargs:${b64(original.args)}${desc}`
}

export function parseDescription(description: string | null | undefined): TaskMarker | null {
  if (!description) return null
  const idM = CHRONOS_RE.exec(description)
  if (!idM) return null
  const schedM = SCHED_RE.exec(description)
  const execM = EXEC_RE.exec(description)
  const argsM = ARGS_RE.exec(description)
  const descM = DESC_RE.exec(description)
  return {
    chronosId: Number(idM[1]),
    scheduleDescriptor: schedM ? schedM[1].trim() : '',
    // Both lines or neither: a half-recorded action would restore something the task never had.
    original: execM && argsM ? { execute: unb64(execM[1].trim()), args: unb64(argsM[1].trim()) } : undefined,
    // Independent of exec/args: a task can have had an empty description, and '' must round-trip
    // as "restore nothing" rather than as "we never recorded it".
    originalDescription: descM ? unb64(descM[1].trim()) : undefined
  }
}

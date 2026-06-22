// SPDX-License-Identifier: Apache-2.0

// ChronosUI stamps managed Task Scheduler tasks with a marker in the task's
// Description field (Task Scheduler has no custom-metadata slot — Description is
// the pragmatic, human-visible analog of crontab's `# chronos:<id>` comment).
// Managed-task Description format (newline-separated):
//   ChronosUI managed job
//   chronos:<id>
//   sched:<trigger descriptor>
// list() reads scheduleExpr straight back from `sched:` — exact, no lossy CIM
// trigger parsing for tasks we created (architect D3).

const CHRONOS_RE = /^chronos:(\d+)$/m
const SCHED_RE = /^sched:(.+)$/m

export interface TaskMarker {
  chronosId: number
  scheduleDescriptor: string
}

export function buildDescription(chronosId: number, scheduleDescriptor: string): string {
  return `ChronosUI managed job\nchronos:${chronosId}\nsched:${scheduleDescriptor}`
}

export function parseDescription(description: string | null | undefined): TaskMarker | null {
  if (!description) return null
  const idM = CHRONOS_RE.exec(description)
  if (!idM) return null
  const schedM = SCHED_RE.exec(description)
  return { chronosId: Number(idM[1]), scheduleDescriptor: schedM ? schedM[1].trim() : '' }
}

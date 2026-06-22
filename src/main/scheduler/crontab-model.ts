// SPDX-License-Identifier: Apache-2.0
// Round-trip-preserving crontab model. We keep EVERY line verbatim and only re-render lines that
// are explicitly changed, so untouched lines (comments, PATH=/MAILTO= env, unmanaged jobs) survive
// byte-for-byte (spec §2 principle 5, §4.2). A library (e.g. cron-parser) parses to an AST and
// discards this structure, so it cannot round-trip — hence this custom model (architect L1).

export interface ModelJob {
  chronosId: number | null // from a preceding `# chronos:<id>` marker; null if unmanaged
  scheduleExpr: string
  command: string // the schedule's command field, verbatim from the (possibly uncommented) line
  enabled: boolean // false if the managed job line is commented out under its marker
  lineIndex: number // index into model.lines of the (job or disabled-job) line — a stable key
  markerIndex: number | null // index of the `# chronos:<id>` line, if managed
}

interface RawLine {
  raw: string
}

export interface CrontabModel {
  lines: RawLine[]
  jobs: ModelJob[]
  setLineRaw(index: number, raw: string): void
}

const MARKER_RE = /^#\s*chronos:(\d+)\s*$/
// A cron job line: 5 schedule fields then the command. Also matches a leading '#' (disabled).
// NOTE: macro schedules (@reboot/@daily/@weekly/…) have ONE field, not 5, so they do not match
// here — they are preserved verbatim on round-trip but not surfaced as jobs in list(). Acceptable
// v0 limitation; Plan 6 can surface them as "unmanaged/unsupported" warnings.
const JOB_RE = /^(#?)\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/
const ENV_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/

function isJobLine(raw: string): boolean {
  if (ENV_RE.test(raw)) return false
  const m = JOB_RE.exec(raw)
  return m !== null
}

export function parseCrontab(text: string): CrontabModel {
  // Split keeping the structure; a trailing newline yields a final empty element we re-join faithfully.
  const parts = text.split('\n')
  const lines: RawLine[] = parts.map((raw) => ({ raw }))

  const jobs: ModelJob[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].raw
    const marker = MARKER_RE.exec(raw)
    if (marker) {
      // The next non-empty line should be a managed job (enabled or commented/disabled).
      const jobIdx = i + 1
      if (jobIdx < lines.length && isJobLine(lines[jobIdx].raw)) {
        const jm = JOB_RE.exec(lines[jobIdx].raw)!
        jobs.push({
          chronosId: Number(marker[1]),
          scheduleExpr: jm[2],
          command: jm[3],
          enabled: jm[1] !== '#',
          lineIndex: jobIdx,
          markerIndex: i
        })
        i = jobIdx
        continue
      }
    }
    // Unmanaged job line (no preceding marker, not commented): expose read-only.
    if (isJobLine(raw) && raw[0] !== '#') {
      const jm = JOB_RE.exec(raw)!
      jobs.push({
        chronosId: null,
        scheduleExpr: jm[2],
        command: jm[3],
        enabled: true,
        lineIndex: i,
        markerIndex: null
      })
    }
  }

  return {
    lines,
    jobs,
    setLineRaw(index: number, raw: string) {
      if (index < 0 || index >= this.lines.length) throw new Error(`setLineRaw: bad index ${index}`)
      this.lines[index].raw = raw
    }
  }
}

export function serializeCrontab(model: CrontabModel): string {
  return model.lines.map((l) => l.raw).join('\n')
}

// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseCrontab, serializeCrontab, type CrontabModel, type ModelJob } from './crontab-model'
import { shellQuote, shellUnquote } from './shell-quote'
import type { AdoptOptions, AdoptionSpec, BatchWriteResult, DriftResult, ExecFn, ParsedJob, SchedulerAdapter, WriteResult } from './types'
export type { ExecFn }

export interface CrontabAdapterOpts {
  exec: ExecFn
  schedmgrPath: string
  dbPath: string
}

// Real ExecFn: shells out to `crontab` via execFile (no shell — args are passed directly).
// stdin is piped for `crontab -`. Used by the app (Plan 5 wires it); tests use a fake instead.
export function makeCrontabExec(): ExecFn {
  return (cmd, args, stdin) =>
    new Promise((resolve) => {
      const child = execFile(cmd, args, (err, stdout) => {
        const exitCode =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0
        resolve({ stdout: stdout ?? '', exitCode })
      })
      if (stdin !== undefined && child.stdin) {
        child.stdin.write(stdin)
        child.stdin.end()
      }
    })
}

// Extract the ORIGINAL command from an adopted line's command field:
// `<schedmgrPath> run <id> --db <db> -- '<quoted original>'` → unquote the part after ` -- `.
function originalFromAdopted(command: string): string {
  const idx = command.indexOf(' -- ')
  if (idx < 0) return command
  return shellUnquote(command.slice(idx + 4).trim())
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class CrontabAdapter implements SchedulerAdapter {
  private snapshotHash: string | null = null

  constructor(private readonly opts: CrontabAdapterOpts) {}

  // public read — records the snapshot hash (used by list()):
  private async read(): Promise<{ text: string; model: CrontabModel }> {
    const { stdout, exitCode } = await this.opts.exec('crontab', ['-l'])
    // `crontab -l` exits non-zero when there is no crontab yet — treat as empty.
    const text = exitCode === 0 ? stdout : ''
    this.snapshotHash = hash(text)
    return { text, model: parseCrontab(text) }
  }

  // mutation read — does NOT touch the snapshot:
  private async readNoSnapshot(): Promise<CrontabModel> {
    const { stdout, exitCode } = await this.opts.exec('crontab', ['-l'])
    return parseCrontab(exitCode === 0 ? stdout : '')
  }

  async list(): Promise<ParsedJob[]> {
    const { model } = await this.read()
    return model.jobs.map((j) => this.toParsed(j))
  }

  // A managed line is "adopted" only if its command is the schedmgr invocation adopt() writes.
  // Checking for ' -- ' would misfire on a plain managed command that legitimately contains ' -- '
  // (e.g. `npm run build -- --watch`), and originalFromAdopted/shellUnquote would then throw,
  // breaking list() for the whole adapter.
  private isAdoptedCommand(command: string): boolean {
    return command.startsWith(this.opts.schedmgrPath + ' run ')
  }

  private toParsed(j: ModelJob): ParsedJob {
    const adopted = j.chronosId !== null && this.isAdoptedCommand(j.command)
    return {
      chronosId: j.chronosId,
      scheduleExpr: j.scheduleExpr,
      scheduleExprFormat: 'cron',
      command: adopted ? originalFromAdopted(j.command) : j.command,
      adopted,
      enabled: j.enabled
    }
  }

  async detectDrift(): Promise<DriftResult> {
    const { stdout, exitCode } = await this.opts.exec('crontab', ['-l'])
    const current = hash(exitCode === 0 ? stdout : '')
    const expected = this.snapshotHash ?? current
    return { drifted: current !== expected, currentHash: current, expectedHash: expected }
  }

  // the choke-point for every mutation: hash-guard against the snapshot, then write via `crontab -`.
  // NOTE: this NARROWS but does not eliminate TOCTOU — a write between detectDrift()'s re-read and
  // `crontab -` is still possible; detectDrift() + the next read are the recovery (architect M3, spec §4.5).
  private async writeGuarded(model: CrontabModel): Promise<WriteResult> {
    const guard = await this.detectDrift()
    if (guard.drifted) return { ok: false, reason: 'drift', drift: guard }
    const text = serializeCrontab(model)
    const { exitCode } = await this.opts.exec('crontab', ['-'], text)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `crontab - exited ${exitCode}` }
    this.snapshotHash = hash(text)
    return { ok: true }
  }

  // disableJob: comment out the managed job line (the rest of CRUD lands in Task 6).
  async disableJob(chronosId: number): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    const j = model.jobs.find((x) => x.chronosId === chronosId)
    if (!j) return { ok: false, reason: 'error', error: `no job ${chronosId}` }
    if (!j.enabled) return { ok: true } // already disabled — no write needed
    model.setLineRaw(j.lineIndex, '#' + model.lines[j.lineIndex].raw)
    return this.writeGuarded(model)
  }

  async createJob(input: { chronosId: number; scheduleExpr: string; command: string }): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    if (model.jobs.some((x) => x.chronosId === input.chronosId)) {
      return { ok: false, reason: 'error', error: `job ${input.chronosId} already exists` }
    }
    // Append marker + bare job line at the end (a trailing empty element keeps a final newline).
    const last = model.lines.length - 1
    const tail = model.lines.length > 0 && model.lines[last].raw === '' ? last : model.lines.length
    model.lines.splice(tail, 0, { raw: `# chronos:${input.chronosId}` }, { raw: `${input.scheduleExpr} ${input.command}` })
    return this.writeGuarded(model)
  }

  async updateJob(chronosId: number, changes: { scheduleExpr?: string; command?: string }): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    const j = model.jobs.find((x) => x.chronosId === chronosId)
    if (!j) return { ok: false, reason: 'error', error: `no job ${chronosId}` }
    // Changing the command of an adopted (schedmgr-wrapped) job here would silently strip the
    // wrapper. Callers must unadopt → re-adopt to change an adopted job's command.
    if (changes.command !== undefined && this.isAdoptedCommand(j.command)) {
      return { ok: false, reason: 'error', error: 'cannot change command of an adopted job; unadopt then adopt' }
    }
    const scheduleExpr = changes.scheduleExpr ?? j.scheduleExpr
    const command = changes.command ?? j.command
    const prefix = j.enabled ? '' : '#'
    model.setLineRaw(j.lineIndex, `${prefix}${scheduleExpr} ${command}`)
    return this.writeGuarded(model)
  }

  async enableJob(chronosId: number): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    const j = model.jobs.find((x) => x.chronosId === chronosId)
    if (!j) return { ok: false, reason: 'error', error: `no job ${chronosId}` }
    if (j.enabled) return { ok: true } // already enabled — no write needed
    model.setLineRaw(j.lineIndex, model.lines[j.lineIndex].raw.replace(/^#\s*/, ''))
    return this.writeGuarded(model)
  }

  async deleteJob(chronosId: number): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    const j = model.jobs.find((x) => x.chronosId === chronosId)
    if (!j) return { ok: false, reason: 'error', error: `no job ${chronosId}` }
    // Remove the job line and its marker (if any). Delete higher index first to keep indices valid.
    const idxs = [j.lineIndex, j.markerIndex].filter((i): i is number => i !== null).sort((x, y) => y - x)
    for (const i of idxs) model.lines.splice(i, 1)
    return this.writeGuarded(model)
  }
  async adopt(chronosId: number, opts: AdoptOptions): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    // Find the unmanaged line matching schedule + command (the line the user chose to adopt).
    const j = model.jobs.find(
      (x) => x.chronosId === null && x.scheduleExpr === opts.scheduleExpr && x.command === opts.command
    )
    if (!j) return { ok: false, reason: 'error', error: 'no matching unadopted line' }
    const wrapped =
      `${opts.scheduleExpr} ${opts.schedmgrPath} run ${chronosId} --db ${shellQuote(opts.dbPath)} ` +
      `-- ${shellQuote(opts.command)}`
    // Replace the job line with the wrapped line, then insert a marker comment above it.
    model.setLineRaw(j.lineIndex, wrapped)
    model.lines.splice(j.lineIndex, 0, { raw: `# chronos:${chronosId}` })
    return this.writeGuarded(model)
  }

  // Adopt several unmanaged lines in ONE read-modify-write (Plan 5, design §6): atomicity
  // (all-or-nothing — a per-line failure can't leave crontab half-wrapped), a single external-edit
  // TOCTOU window, and one `crontab -` round-trip instead of N. Uses this.opts.{schedmgrPath,dbPath}.
  async adoptMany(specs: AdoptionSpec[]): Promise<BatchWriteResult> {
    if (specs.length === 0) return { ok: true, adopted: [] }
    const model = await this.readNoSnapshot()
    // Resolve every target line first; abort before any mutation if one is missing (atomicity).
    const targets: Array<{ spec: AdoptionSpec; lineIndex: number }> = []
    for (const spec of specs) {
      const j = model.jobs.find(
        (x) => x.chronosId === null && x.scheduleExpr === spec.scheduleExpr && x.command === spec.command
      )
      if (!j) {
        return { ok: false, reason: 'error', errorCode: 'no_match', error: `no matching unadopted line for ${spec.chronosId}`, adopted: [] }
      }
      targets.push({ spec, lineIndex: j.lineIndex })
    }
    // Two specs that resolved to the SAME native line (identical duplicate crontab entries) would
    // corrupt the table — the second setLineRaw overwrites the first's marker and leaves a line
    // unwrapped while the DB marks both adopted. Reject the batch rather than corrupt (code review #3).
    if (new Set(targets.map((t) => t.lineIndex)).size !== targets.length) {
      return { ok: false, reason: 'error', errorCode: 'no_match', error: 'two specs matched the same crontab line', adopted: [] }
    }
    // setLineRaw replaces the job line in place; splice(lineIndex, 0, marker) inserts the marker
    // above it. Process highest line index first so earlier marker inserts don't shift later indices.
    targets.sort((a, b) => b.lineIndex - a.lineIndex)
    for (const { spec, lineIndex } of targets) {
      const wrapped =
        `${spec.scheduleExpr} ${this.opts.schedmgrPath} run ${spec.chronosId} --db ${shellQuote(this.opts.dbPath)} ` +
        `-- ${shellQuote(spec.command)}`
      model.setLineRaw(lineIndex, wrapped)
      model.lines.splice(lineIndex, 0, { raw: `# chronos:${spec.chronosId}` })
    }
    const w = await this.writeGuarded(model)
    if (!w.ok) return { ...w, adopted: [] }
    return { ok: true, adopted: specs.map((s) => s.chronosId) }
  }

  async unadopt(chronosId: number, originalCommand: string): Promise<WriteResult> {
    const model = await this.readNoSnapshot()
    const j = model.jobs.find((x) => x.chronosId === chronosId)
    if (!j || j.markerIndex === null) return { ok: false, reason: 'error', error: `job ${chronosId} not adopted` }
    // Restore the bare original line (preserve enabled/disabled state) and drop the marker.
    const prefix = j.enabled ? '' : '#'
    model.setLineRaw(j.lineIndex, `${prefix}${j.scheduleExpr} ${originalCommand}`)
    model.lines.splice(j.markerIndex, 1) // remove the marker line (above the job)
    return this.writeGuarded(model)
  }
}

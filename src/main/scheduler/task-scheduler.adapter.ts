// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readableStderr } from './clixml'
import { winQuoteArg, winUnquoteArg, psQuote } from './win-quote'
import { parseTriggerDescriptor, triggerSpecToDescriptor, triggerSpecToPwsh, cimTriggerToDescriptor } from './trigger-model'
import { buildDescription, parseDescription } from './task-marker'
import type { AdoptOptions, AdoptionSpec, BatchWriteResult, DriftResult, ExecFn, ParsedJob, ReleaseResult, ReleaseSpec, SchedulerAdapter, WriteResult } from './types'

// Windows floor: Windows 10 1709+ / PowerShell 5.1+ (the ScheduledTasks module).
// We drive the cmdlets (Get/New/Set/Register/Unregister/Enable/Disable-ScheduledTask),
// NOT schtasks.exe — schtasks cannot read/write the Description field we use as the
// chronos marker, and its CSV/XML surface is brittle to parse (architect D1c).

/**
 * Base flags; the script itself rides in `-EncodedCommand <base64 UTF-16LE>`, appended per call.
 *
 * NOT `-Command -` (script on stdin), which is what this used to be. A multi-line argument put
 * PowerShell into line-continuation; at EOF it discarded the buffered script and exited 0. The
 * cmdlet never ran, the adapter read exit 0 as success, and the database kept a job the scheduler
 * had never been told about. `$ErrorActionPreference = 'Stop'` did not abort in that mode either,
 * so error detection was unreliable for every method here, not just the one that was noticed.
 * Measured on Windows 11, 2026-09-04.
 */
const PS_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-EncodedCommand']

/**
 * Cap on the base64 payload. Windows caps a CreateProcessW command line at ~32767 characters, and
 * `spawn` without `shell: true` goes straight there. stdin had no such limit, so moving the script
 * into argv introduces a failure mode that did not exist before — this makes it a legible error
 * instead of an opaque spawn failure. The remainder of the budget covers the executable path and
 * the flags above. base64(UTF-16LE(s)) is about 2.67x the length of s, so this still allows a
 * ~9000-character script against the 1-2 KB the templates actually produce.
 */
export const PS_MAX_ENCODED_LEN = 24000

/**
 * Marks the line the wrapper writes when the body throws. Chosen to be something no cmdlet emits.
 */
export const PWSH_ERROR_MARKER = 'chronos-error: '

/**
 * Wrap a script so it reports its own failure on stdout.
 *
 * Windows measured 2026-09-05: with `[Console]::OutputEncoding` set to UTF-8 the raw bytes on
 * stderr still arrived as cp950. That setting reaches stdout; the error stream is written by the
 * host and does not follow it. Chasing the encoding of a channel we do not control means guessing
 * the remote codepage — cp950 on zh-TW, cp936 on zh-CN, cp932 on ja-JP, cp850 across much of
 * Western Europe — and shipping a decoder for each.
 *
 * So the error does not travel on that channel. The body runs inside a catch that writes the
 * message to stdout, which is measurably UTF-8, and exits non-zero. Three problems leave together:
 *
 *   - the encoding, because the message now goes the way that works;
 *   - the CLIXML envelope, because PowerShell only produces it for the error stream;
 *   - the echoed script, because we emit the message alone and none of PowerShell's error
 *     formatting — including the width-truncated `+ …` fragment that survived being matched
 *     against the full script text.
 *
 * `exit` inside the body still exits immediately; `Write-Error` under Stop throws first and lands
 * in the catch, which is how the existing collision guard keeps working.
 *
 * `[Console]::Out.WriteLine` rather than `Write-Output`, for two reasons. It writes straight to the
 * process's stdout instead of through PowerShell's host, so it is not subject to the console-width
 * wrapping that split "exists" into "exist" + "s" in the CLIXML records; and it uses the encoding
 * just assigned on the line above, which is the whole point of the exercise.
 *
 * ProgressPreference is silenced because progress records are the other thing PowerShell writes to
 * stderr — the cp950 bytes measured on Windows were "正在準備模組以便第一次使用", a progress
 * record. Nothing reads them.
 */
export function wrapPwshScript(body: string): string {
  return [
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    body,
    `} catch {`,
    `  [Console]::Out.WriteLine('${PWSH_ERROR_MARKER}' + $_.Exception.Message)`,
    `  exit 1`,
    `}`
  ].join('\n')
}

/**
 * The message a failed run should show.
 *
 * The marked line first: that is the wrapper's own report, already plain UTF-8 text. Everything
 * else is a fallback for a failure that never reached the catch — and it must not be empty, since
 * a failure reported as no message is the same defect as one reported as success.
 */
export function errorMessageFrom(stdout: string, stderr: string, script: string | undefined): string {
  const marked = stdout.split(/\r?\n/).find((l) => l.startsWith(PWSH_ERROR_MARKER))
  if (marked) return marked.slice(PWSH_ERROR_MARKER.length).trim()
  const rest = (stdout + readableStderr(stderr, script)).trim()
  return rest || 'powershell failed without producing a message'
}

/** What `-EncodedCommand` takes: UTF-16LE code units, base64, no BOM. Exported so the real-process
 *  smoke test encodes through exactly this function rather than a second copy that could drift. */
export function encodePwshScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}
const DEFAULT_FOLDER = '\\ChronosUI\\'

export interface TaskSchedulerAdapterOpts {
  exec: ExecFn
  schedmgrPath: string // absolute path to schedmgr.exe
  dbPath: string
  taskFolder?: string // default '\ChronosUI\'
}

interface RawAction { Execute: string | null; Arguments: string | null }
interface RawTask {
  TaskName: string
  TaskPath: string
  Description: string | null
  State: string
  Actions: RawAction[]
  Triggers: import('./trigger-model').CimTrigger[]
  Xml?: string | null
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Strip volatile elements Task Scheduler rewrites on OS updates / re-registration
// so they do not cause false drift (architect D6).
export function normalizeTaskXml(xml: string): string {
  return xml
    .replace(/<Date>.*?<\/Date>/gs, '')
    .replace(/<SecurityDescriptor>.*?<\/SecurityDescriptor>/gs, '')
    .replace(/<Author>.*?<\/Author>/gs, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ConvertTo-Json yields '' (empty set), a bare object (one task), or an array
// (many) — normalize to an array (architect D1b).
function parseTasksJson(stdout: string): RawTask[] {
  const s = stdout.trim()
  if (!s) return []
  const parsed = JSON.parse(s)
  return Array.isArray(parsed) ? parsed : [parsed]
}

// Recover the original command from an adopted action's Arguments:
// 'run <id> --db <qdb> -- <qcommand>' → winUnquote the token after ' -- '.
function originalFromAdopted(args: string): string {
  const idx = args.indexOf(' -- ')
  if (idx < 0) return args
  return winUnquoteArg(args.slice(idx + 4).trim())
}

// Recover the command from an unadopted managed action: cmd.exe '/c <command>'.
function commandFromCmdC(args: string | null): string {
  const a = args ?? ''
  return a.startsWith('/c ') ? a.slice(3) : a
}

export class TaskSchedulerAdapter implements SchedulerAdapter {
  private readonly folder: string
  // per-task drift snapshot: chronosId → normalized-XML hash (architect D6).
  private snapshots = new Map<number, string>()

  constructor(private readonly opts: TaskSchedulerAdapterOpts) {
    this.folder = opts.taskFolder ?? DEFAULT_FOLDER
  }

  // Run a PowerShell script via the injected exec. Prepends Stop so a non-terminating cmdlet error
  // becomes a non-zero exit (architect D2) — whether that actually holds is a property of the
  // delivery mode, which is why it is the first thing the Windows checklist re-tests.
  private async ps(script: string): Promise<{ stdout: string; exitCode: number }> {
    const encoded = encodePwshScript(wrapPwshScript(script))
    if (encoded.length > PS_MAX_ENCODED_LEN) {
      // Shaped like a PowerShell failure so every caller's existing non-zero handling reports it,
      // rather than adding a second error channel none of them read.
      return {
        stdout: `script too long for the Windows command line: ${encoded.length} encoded characters, limit ${PS_MAX_ENCODED_LEN}`,
        exitCode: 1
      }
    }
    return this.opts.exec('powershell.exe', [...PS_BASE_ARGS, encoded])
  }

  private taskName(chronosId: number): string {
    return `chronos-${chronosId}`
  }

  private buildListScript(): string {
    // Managed tasks (our folder) + user tasks (non-Microsoft) for read-only adoption
    // display. Shallow projection so ConvertTo-Json is stable; @() forces an array
    // (architect D1b); Xml is exported per task so list() can snapshot drift hashes.
    return `
$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskPath -eq '${this.folder}' -or $_.TaskPath -notlike '\\Microsoft\\*' })
$out = foreach ($t in $tasks) {
  [pscustomobject]@{
    TaskName = $t.TaskName
    TaskPath = $t.TaskPath
    Description = $t.Description
    State = [string]$t.State
    Actions = @($t.Actions | ForEach-Object { [pscustomobject]@{ Execute = $_.Execute; Arguments = $_.Arguments } })
    Triggers = @($t.Triggers | ForEach-Object { [pscustomobject]@{
      CimClass = $_.CimClass.CimClassName
      StartBoundary = $_.StartBoundary
      DaysOfWeek = $_.DaysOfWeek
      Repetition = if ($_.Repetition) { [pscustomobject]@{ Interval = $_.Repetition.Interval } } else { $null }
    }})
    Xml = ([string](Export-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath))
  }
}
ConvertTo-Json -InputObject @($out) -Depth 8 -Compress
`.trim()
  }

  async list(): Promise<ParsedJob[]> {
    const { stdout } = await this.ps(this.buildListScript())
    const raw = parseTasksJson(stdout)
    this.snapshots.clear()
    const jobs: ParsedJob[] = []
    for (const t of raw) {
      const action0 = t.Actions[0] ?? { Execute: '', Arguments: '' }
      if (this.isFlushAction(action0.Execute, action0.Arguments)) continue
      const parsed = this.toParsed(t)
      if (parsed.chronosId !== null && t.Xml) {
        this.snapshots.set(parsed.chronosId, hash(normalizeTaskXml(t.Xml)))
      }
      jobs.push(parsed)
    }
    return jobs
  }

  private toParsed(t: RawTask): ParsedJob {
    const marker = parseDescription(t.Description)
    const enabled = t.State !== 'Disabled'
    const action = t.Actions[0] ?? { Execute: '', Arguments: '' }
    if (marker) {
      const adopted = (action.Execute ?? '') === this.opts.schedmgrPath
      return {
        chronosId: marker.chronosId,
        scheduleExpr: marker.scheduleDescriptor, // exact — stashed at create/update
        scheduleExprFormat: 'win-trigger',
        command: adopted ? originalFromAdopted(action.Arguments ?? '') : commandFromCmdC(action.Arguments),
        adopted,
        enabled,
        name: t.TaskName // #8
      }
    }
    // Unmanaged external task: read-only adoption candidate.
    const trig = t.Triggers[0]
    const desc = trig ? cimTriggerToDescriptor(trig) : { descriptor: '(no trigger)', lossy: true }
    const canAdopt = t.Actions.length === 1 && !!action.Execute
    return {
      chronosId: null,
      scheduleExpr: desc.descriptor,
      scheduleExprFormat: 'win-trigger',
      command: `${action.Execute ?? ''}${action.Arguments ? ' ' + action.Arguments : ''}`.trim(),
      adopted: false,
      enabled,
      canAdopt,
      scheduleLossy: desc.lossy,
      name: t.TaskName // #8: surface the real Task Scheduler name for unmanaged tasks
    }
  }

  // Read ONE managed task's XML and hash its normalized form. '' if the task is gone.
  private async taskXmlHash(chronosId: number): Promise<string> {
    const { stdout, exitCode } = await this.ps(
      `(Export-ScheduledTask -TaskName '${this.taskName(chronosId)}' -TaskPath '${this.folder}')`
    )
    if (exitCode !== 0) return '' // task gone/unreadable → '' ≠ snapshot, so guard() refuses as drift
    return hash(normalizeTaskXml(stdout))
  }

  async detectDrift(): Promise<DriftResult> {
    for (const [id, expected] of this.snapshots) {
      const current = await this.taskXmlHash(id)
      if (current !== expected) return { drifted: true, currentHash: current, expectedHash: expected }
    }
    return { drifted: false, currentHash: '', expectedHash: '' }
  }

  // Hash-guard a single managed task before mutating it. Refuse on mismatch
  // (someone edited it externally since list()). Returns a drift WriteResult to
  // bail with, or null to proceed. (architect D6, spec §4.5)
  private async guard(chronosId: number): Promise<WriteResult | null> {
    const expected = this.snapshots.get(chronosId)
    if (expected === undefined) return null // not snapshotted (e.g. createJob) — caller checks existence
    const current = await this.taskXmlHash(chronosId)
    if (current !== expected) {
      return { ok: false, reason: 'drift', drift: { drifted: true, currentHash: current, expectedHash: expected } }
    }
    return null
  }

  private async refreshSnapshot(chronosId: number): Promise<void> {
    this.snapshots.set(chronosId, await this.taskXmlHash(chronosId))
  }

  // Run a mutating script on an existing managed task behind the drift guard.
  private async mutate(chronosId: number, script: string): Promise<WriteResult> {
    const g = await this.guard(chronosId)
    if (g) return g
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `powershell exited ${exitCode}: ${stdout}`.trim() }
    await this.refreshSnapshot(chronosId)
    return { ok: true }
  }

  // Intentional divergence from CrontabAdapter: enable/disable ALWAYS run the drift
  // guard (via mutate) regardless of the task's current State. CrontabAdapter short-
  // circuits when the job is already in the target state; here an externally-edited
  // task surfaces drift rather than a silent no-op. Plan 5's IPC layer should account
  // for this difference — both adapters share the SchedulerAdapter interface but differ
  // in this idempotency behavior.
  async enableJob(chronosId: number): Promise<WriteResult> {
    return this.mutate(chronosId, `Enable-ScheduledTask -TaskName '${this.taskName(chronosId)}' -TaskPath '${this.folder}' | Out-Null`)
  }

  async disableJob(chronosId: number): Promise<WriteResult> {
    return this.mutate(chronosId, `Disable-ScheduledTask -TaskName '${this.taskName(chronosId)}' -TaskPath '${this.folder}' | Out-Null`)
  }

  // Read ONE managed task's current action + marker WITHOUT touching the drift
  // snapshot (so adopt/unadopt/update can inspect state without defeating the guard).
  private async readOne(chronosId: number): Promise<{ adopted: boolean; command: string; scheduleDescriptor: string } | null> {
    const name = this.taskName(chronosId)
    const script = `
$t = Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -ErrorAction SilentlyContinue
if (-not $t) { ''; exit 0 }
$a = $t.Actions[0]
[pscustomobject]@{ Execute = $a.Execute; Arguments = $a.Arguments; Description = $t.Description } | ConvertTo-Json -Compress
`.trim()
    const { stdout } = await this.ps(script)
    const s = stdout.trim()
    if (!s) return null
    const o = JSON.parse(s) as { Execute: string | null; Arguments: string | null; Description: string | null }
    const adopted = (o.Execute ?? '') === this.opts.schedmgrPath
    const marker = parseDescription(o.Description)
    return {
      adopted,
      command: adopted ? originalFromAdopted(o.Arguments ?? '') : commandFromCmdC(o.Arguments),
      scheduleDescriptor: marker?.scheduleDescriptor ?? ''
    }
  }

  async adopt(chronosId: number, opts: AdoptOptions): Promise<WriteResult> {
    const g = await this.guard(chronosId)
    if (g) return g
    const cur = await this.readOne(chronosId)
    if (!cur) return { ok: false, reason: 'error', error: `no job ${chronosId}` }
    if (cur.adopted) return { ok: false, reason: 'error', error: `job ${chronosId} already adopted` }
    // Pre-check: refuse elevated (HighestAvailable) tasks before mutating (architect D4).
    const name = this.taskName(chronosId)
    const elevatedCheck = await this.ps(
      `$t = Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}'\n` +
      `if ($t.Principal.RunLevel -eq 'Highest') { 'elevated'; exit 1 } else { 'ok'; exit 0 }`
    )
    if (elevatedCheck.exitCode !== 0) {
      return { ok: false, reason: 'error', error: 'refusing to adopt an elevated (HighestAvailable) task' }
    }
    // Build the schedmgr.exe Arguments. TWO distinct layers (architect D4):
    //   inner winQuoteArg(dbPath) + winQuoteArg(command) — CommandLineToArgvW, so
    //     when the task fires Windows hands schedmgr each as ONE argv token;
    //   outer psQuote(whole) — PowerShell literal, so it embeds in this script.
    // NOT winQuote(winQuote(cmd)): the lone winQuote is consumed by
    // CommandLineToArgvW, leaving schedmgr the bare command for `cmd /c`; a second
    // winQuote would leak literal quotes into cmd /c and break && | > . Chain:
    // TaskSched Arguments -> CommandLineToArgvW -> Go os.Args -> joinArgs -> cmd /c.
    const argString = `run ${chronosId} --db ${winQuoteArg(opts.dbPath)} -- ${winQuoteArg(opts.command)}`
    const script = `
$t = Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}'
$t.Actions = @(New-ScheduledTaskAction -Execute ${psQuote(opts.schedmgrPath)} -Argument ${psQuote(argString)})
Set-ScheduledTask -InputObject $t | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `adopt failed (${exitCode}): ${stdout}`.trim() }
    await this.refreshSnapshot(chronosId)
    return { ok: true }
  }

  // Windows edits each task directly (no whole-table TOCTOU), so adoptMany is a per-task sequential
  // loop over the per-task-tested adopt(). Stops at the first failure and reports the prefix adopted;
  // the service rolls back DB rows for the ids not in `adopted` (Plan 5, design §6).
  async adoptMany(specs: AdoptionSpec[]): Promise<BatchWriteResult> {
    const adopted: number[] = []
    for (const spec of specs) {
      const w = await this.adopt(spec.chronosId, {
        scheduleExpr: spec.scheduleExpr,
        command: spec.command,
        schedmgrPath: this.opts.schedmgrPath,
        dbPath: this.opts.dbPath
      })
      if (!w.ok) return { ...w, adopted }
      adopted.push(spec.chronosId)
    }
    return { ok: true, adopted }
  }

  // teardown: release every listed task. Per-task, mirroring adoptMany's accepted non-atomic shape on
  // this platform (types.ts documents the crontab/Windows split). Unlike adoptMany, a task that is no
  // longer registered goes to `skipped` and the loop continues — teardown is the user's exit path and
  // must not be blocked by one externally removed task (spec §2).
  //
  // NOTE: this deliberately does NOT call guard(). A task whose XML drifted since we snapshotted it is
  // still a task we must un-mark; refusing would leave a schedmgr-wrapped action pointing at a binary
  // the user is about to delete, which is strictly worse than overwriting an external edit.
  async releaseAll(specs: ReleaseSpec[]): Promise<ReleaseResult> {
    const released: number[] = []
    const skipped: { chronosId: number; reason: 'no_match' }[] = []

    for (const spec of specs) {
      const cur = await this.readOne(spec.chronosId)
      if (!cur) {
        skipped.push({ chronosId: spec.chronosId, reason: 'no_match' })
        continue
      }
      const name = this.taskName(spec.chronosId)
      // An adopted task also needs its action restored; a created one keeps the action it has.
      const restoreAction = cur.adopted
        ? `$t.Actions = @(New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + spec.originalCommand)})\n`
        : ''
      const script = `
$t = Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}'
${restoreAction}$t.Description = ''
Set-ScheduledTask -InputObject $t | Out-Null
`.trim()
      const { exitCode, stdout } = await this.ps(script)
      if (exitCode !== 0) {
        return {
          ok: false,
          reason: 'error',
          error: `releaseAll failed on ${spec.chronosId} (${exitCode}): ${stdout}`.trim(),
          released,
          skipped
        }
      }
      this.snapshots.delete(spec.chronosId)
      released.push(spec.chronosId)
    }

    return { ok: true, released, skipped }
  }

  async unadopt(chronosId: number, originalCommand: string): Promise<WriteResult> {
    const g = await this.guard(chronosId)
    if (g) return g
    const cur = await this.readOne(chronosId)
    if (!cur || !cur.adopted) return { ok: false, reason: 'error', error: `job ${chronosId} not adopted` }
    const name = this.taskName(chronosId)
    const script = `
$t = Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}'
$t.Actions = @(New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + originalCommand)})
Set-ScheduledTask -InputObject $t | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `unadopt failed (${exitCode}): ${stdout}`.trim() }
    await this.refreshSnapshot(chronosId)
    return { ok: true }
  }

  async createJob(input: { chronosId: number; scheduleExpr: string; command: string }): Promise<WriteResult> {
    let spec
    try {
      spec = parseTriggerDescriptor(input.scheduleExpr)
    } catch (e) {
      return { ok: false, reason: 'error', error: (e as Error).message }
    }
    const name = this.taskName(input.chronosId)
    const desc = buildDescription(input.chronosId, triggerSpecToDescriptor(spec))
    // Unadopted managed job runs through cmd.exe so shell operators behave like
    // cron's /bin/sh (Task Scheduler has no shell). RunLevel Limited = no elevation;
    // MultipleInstances IgnoreNew = no overlapping runs (spec §8, architect D7).
    // RunLevel/UserId go on a Principal — Register-ScheduledTask's -InputObject is a
    // DIFFERENT parameter set than -User/-RunLevel, so combining them throws
    // AmbiguousParameterSet on PowerShell 5.1 (found by the Plan 4b Windows test).
    // LogonType Interactive = runs only while the user is logged on, no stored
    // credential — same semantics as the old `Register -User <name>` default.
    const script = `
if (Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -ErrorAction SilentlyContinue) { Write-Error 'exists'; exit 1 }
$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + input.command)}
$t = ${triggerSpecToPwsh(spec)}
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description ${psQuote(desc)}
Register-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -InputObject $task | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `create failed (${exitCode}): ${stdout}`.trim() }
    await this.refreshSnapshot(input.chronosId)
    return { ok: true }
  }

  async updateJob(chronosId: number, changes: { scheduleExpr?: string; command?: string }): Promise<WriteResult> {
    const g = await this.guard(chronosId)
    if (g) return g
    const cur = await this.readOne(chronosId)
    if (!cur) return { ok: false, reason: 'error', error: `no job ${chronosId}` }
    // Changing an adopted job's command here would silently strip the schedmgr
    // wrapper — same guard as the crontab adapter. Caller must unadopt → adopt.
    if (changes.command !== undefined && cur.adopted) {
      return { ok: false, reason: 'error', error: 'cannot change command of an adopted job; unadopt then adopt' }
    }
    const descriptor = changes.scheduleExpr ?? cur.scheduleDescriptor
    let spec
    try {
      spec = parseTriggerDescriptor(descriptor)
    } catch (e) {
      return { ok: false, reason: 'error', error: (e as Error).message }
    }
    const command = changes.command ?? cur.command
    // Rebuild the action in the same form the task currently has (adopted vs cmd /c).
    const actionExpr = cur.adopted
      ? `New-ScheduledTaskAction -Execute ${psQuote(this.opts.schedmgrPath)} -Argument ${psQuote(`run ${chronosId} --db ${winQuoteArg(this.opts.dbPath)} -- ${winQuoteArg(command)}`)}`
      : `New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + command)}`
    const newDesc = buildDescription(chronosId, triggerSpecToDescriptor(spec))
    const name = this.taskName(chronosId)
    const script = `
$t = Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}'
$t.Triggers = @(${triggerSpecToPwsh(spec)})
$t.Actions = @(${actionExpr})
$t.Description = ${psQuote(newDesc)}
Set-ScheduledTask -InputObject $t | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `update failed (${exitCode}): ${stdout}`.trim() }
    await this.refreshSnapshot(chronosId)
    return { ok: true }
  }

  async deleteJob(chronosId: number): Promise<WriteResult> {
    const g = await this.guard(chronosId)
    if (g) return g
    const { exitCode, stdout } = await this.ps(
      `Unregister-ScheduledTask -TaskName '${this.taskName(chronosId)}' -TaskPath '${this.folder}' -Confirm:$false`
    )
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `delete failed (${exitCode}): ${stdout}`.trim() }
    this.snapshots.delete(chronosId)
    return { ok: true }
  }

  private static readonly FLUSH_TASK = 'chronos-notify-flush'

  private isFlushAction(execute: string | null, args: string | null): boolean {
    return (execute ?? '') === this.opts.schedmgrPath && (args ?? '').startsWith('notify-flush')
  }

  async installFlushEntry(windowMin: number): Promise<WriteResult> {
    if (!Number.isInteger(windowMin) || windowMin < 1) {
      return { ok: false, reason: 'error', error: `installFlushEntry: windowMin must be ≥1, got ${windowMin}` }
    }
    const name = TaskSchedulerAdapter.FLUSH_TASK
    const argString = `notify-flush --db ${winQuoteArg(this.opts.dbPath)}`
    const script = `
if (Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -Confirm:$false
}
$a = New-ScheduledTaskAction -Execute ${psQuote(this.opts.schedmgrPath)} -Argument ${psQuote(argString)}
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${windowMin})
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description 'ChronosUI notify-flush'
Register-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -InputObject $task | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `install flush failed (${exitCode}): ${stdout}`.trim() }
    return { ok: true }
  }

  async removeFlushEntry(): Promise<WriteResult> {
    const name = TaskSchedulerAdapter.FLUSH_TASK
    const script = `
if (Get-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName '${name}' -TaskPath '${this.folder}' -Confirm:$false
}
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `remove flush failed (${exitCode}): ${stdout}`.trim() }
    return { ok: true }
  }
}

// Real ExecFn: runs PowerShell with the script already encoded into `args` (-EncodedCommand). On
// success returns clean stdout (JSON); on failure folds stderr in for the error message. Used by
// the app (Plan 5 wires it); tests use a fake instead.
//
// The stdin parameter stays in ExecFn because the crontab adapter still needs it (`crontab -`), but
// nothing may deliver a PowerShell script that way again — so this throws rather than quietly
// accepting it. Left merely unused, the path would be an invitation to reconnect the silent failure
// that -EncodedCommand exists to remove, and no test would catch it: the fake exec accepted stdin
// happily for as long as the bug existed.
/** The script this call sent, read back out of its own -EncodedCommand argument. */
function decodeSentScript(args: string[]): string | undefined {
  const i = args.indexOf('-EncodedCommand')
  if (i < 0 || !args[i + 1]) return undefined
  try {
    return Buffer.from(args[i + 1], 'base64').toString('utf16le')
  } catch {
    return undefined // not our shape; readableStderr then leaves the message as it found it
  }
}

export function makePowerShellExec(): ExecFn {
  return (cmd, args, stdin) => {
    if (stdin !== undefined) {
      throw new Error('makePowerShellExec: script delivery via stdin is not supported — use -EncodedCommand')
    }
    return new Promise((resolve) => {
      const child = spawn(cmd, args)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => resolve({ stdout: (err as Error).message, exitCode: 1 }))
      child.on('close', (code) => {
        const ok = (code ?? 1) === 0
        // On failure this string is put in front of the user. PowerShell answers with CLIXML
        // whenever stderr is redirected, and echoes the script inside it — under -EncodedCommand
        // that is the whole script on one line, job command included. The script is recovered from
        // the argument we just sent rather than threaded through, so the echo is matched exactly
        // instead of guessed at from the surrounding line furniture, which is localized.
        resolve({ stdout: ok ? stdout : errorMessageFrom(stdout, stderr, decodeSentScript(args)), exitCode: code ?? 1 })
      })
    })
  }
}

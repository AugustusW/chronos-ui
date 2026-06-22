// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { winQuoteArg, winUnquoteArg, psQuote } from './win-quote'
import { parseTriggerDescriptor, triggerSpecToDescriptor, triggerSpecToPwsh, cimTriggerToDescriptor } from './trigger-model'
import { buildDescription, parseDescription } from './task-marker'
import type { AdoptOptions, AdoptionSpec, BatchWriteResult, DriftResult, ExecFn, ParsedJob, SchedulerAdapter, WriteResult } from './types'

// Windows floor: Windows 10 1709+ / PowerShell 5.1+ (the ScheduledTasks module).
// We drive the cmdlets (Get/New/Set/Register/Unregister/Enable/Disable-ScheduledTask),
// NOT schtasks.exe — schtasks cannot read/write the Description field we use as the
// chronos marker, and its CSV/XML surface is brittle to parse (architect D1c).

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-Command', '-']
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

  // Run a PowerShell script via the injected exec. Prepends Stop so a
  // non-terminating cmdlet error becomes a non-zero exit (architect D2).
  private async ps(script: string): Promise<{ stdout: string; exitCode: number }> {
    return this.opts.exec('powershell.exe', PS_ARGS, `$ErrorActionPreference = 'Stop'\n` + script)
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
        enabled
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
      scheduleLossy: desc.lossy
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
}

// Real ExecFn: runs PowerShell with the script piped via stdin (-Command -). On
// success returns clean stdout (JSON); on failure folds stderr in for the error
// message. Used by the app (Plan 5 wires it); tests use a fake instead.
export function makePowerShellExec(): ExecFn {
  return (cmd, args, stdin) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => (stdout += d.toString()))
      child.stderr.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => resolve({ stdout: (err as Error).message, exitCode: 1 }))
      child.on('close', (code) => {
        const ok = (code ?? 1) === 0
        resolve({ stdout: ok ? stdout : stdout + stderr, exitCode: code ?? 1 })
      })
      if (stdin !== undefined && child.stdin) {
        child.stdin.write(stdin)
        child.stdin.end()
      }
    })
}

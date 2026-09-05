// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readableStderr } from './clixml'
import { winQuoteArg, winUnquoteArg, psQuote } from './win-quote'
import { parseTriggerDescriptor, triggerSpecToDescriptor, triggerSpecToPwsh, cimTriggerToDescriptor } from './trigger-model'
import { buildDescription, parseDescription, type OriginalAction } from './task-marker'
import type { AdoptOptions, AdoptionSpec, BatchWriteResult, DriftResult, ExecFn, NativeTaskRef, ParsedJob, ReleaseResult, ReleaseSpec, SchedulerAdapter, WriteResult } from './types'

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

/** Comment stamped on the marker-scan script. It carries no meaning to PowerShell; it exists so a
 *  fake exec can tell this script apart from list()'s, which asks for an overlapping set of
 *  fields. Routing a test double on incidental differences between two similar scripts is how a
 *  fake ends up answering the wrong one. */
export const MARKER_SCAN_TAG = 'chronos:marker-scan'

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

/**
 * Nothing on the machine carries this job's marker.
 *
 * Said in full because `no job N` reads as "ChronosUI has no such job", which is the opposite of
 * what happened: ChronosUI has the job, the scheduled task behind it is what is missing. The two
 * send the user looking in different places.
 */
function noSuchTask(chronosId: number): string {
  return `job ${chronosId}: no scheduled task carries its marker any more. The task was removed, or its description was cleared.`
}

/** The task was where we thought, and then would not read back. Different from having no location
 *  at all, and worth saying so: it names where we looked. */
function taskUnreadable(chronosId: number, at: NativeTaskRef): string {
  return `job ${chronosId}: the scheduled task at ${at.path}${at.name} could not be read.`
}

/** Two tasks, one marker. Name both, because the fix is manual: the user has to decide which
 *  copy is the real one, and cannot do that without knowing where they are. */
function ambiguityError(chronosId: number, where: NativeTaskRef[]): Error {
  return new Error(
    `ambiguous marker chronos:${chronosId} — ${where.map((w) => `${w.path}${w.name}`).join(', ')}`
  )
}

/** Everything one read of a task tells us. Named because three methods return it and the shape
 *  grew past the point where repeating it inline stayed readable. */
interface TaskReadback {
  adopted: boolean
  command: string
  scheduleDescriptor: string
  action: OriginalAction
  recorded?: OriginalAction
  recordedDescription?: string
  description: string
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
  /**
   * Per-task cache: where the task is, and what it looked like when we last saw it.
   *
   * One map, not two. `deleteJob` and `releaseAll` each drop an entry and `refreshSnapshot`
   * updates one; a second map would mean a second call at each of those points, and the one
   * everybody forgets is the one that breaks. Keeping location and hash together also makes the
   * invariant obvious: if we know a task's hash we know where we read it from.
   */
  private snapshots = new Map<number, { name: string; path: string; hash?: string }>()

  /**
   * Ids that more than one task claims. Kept apart from `snapshots` on purpose: an ambiguous id
   * must have NO cached location, because any location we cached would be a guess, and a guess
   * here sends every later write for that id to an arbitrary one of the two.
   *
   * It is per-id rather than a single flag so one duplicate cannot strand the rest of the machine.
   * teardown is the user's way out; a stray Export/Import copy must not block it.
   */
  private ambiguous = new Map<number, NativeTaskRef[]>()

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

  /**
   * The set of tasks ChronosUI will look at: our own folder, plus anything outside Microsoft's.
   *
   * Shared by list() and the marker lookup so "the fallback scans what list() scans" is enforced
   * rather than asserted. Two copies of this string would let the ranges drift apart silently, and
   * the NFR argument for the fallback ("one scan costs what list() costs") rests on them matching.
   */
  private taskScope(): string {
    return `$_.TaskPath -eq '${this.folder}' -or $_.TaskPath -notlike '\\Microsoft\\*'`
  }

  private taskName(chronosId: number): string {
    return `chronos-${chronosId}`
  }

  private buildListScript(): string {
    // Managed tasks (our folder) + user tasks (non-Microsoft) for read-only adoption
    // display. Shallow projection so ConvertTo-Json is stable; @() forces an array
    // (architect D1b); Xml is exported per task so list() can snapshot drift hashes.
    return `
$tasks = @(Get-ScheduledTask | Where-Object { ${this.taskScope()} })
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
    this.ambiguous.clear()
    const jobs: ParsedJob[] = []
    for (const t of raw) {
      const action0 = t.Actions[0] ?? { Execute: '', Arguments: '' }
      if (this.isFlushAction(action0.Execute, action0.Arguments)) continue
      const parsed = this.toParsed(t)
      if (parsed.chronosId !== null && t.Xml) {
        // The name and folder come from the task itself, not from the chronosId. An adopted task
        // keeps the identity it already had.
        const here = { name: t.TaskName, path: t.TaskPath }
        const prior = this.snapshots.get(parsed.chronosId)
        if (prior || this.ambiguous.has(parsed.chronosId)) {
          // Two tasks carrying one marker. Last-write-wins would silently point the id at
          // whichever came second in the enumeration order.
          const all = this.ambiguous.get(parsed.chronosId) ?? (prior ? [{ name: prior.name, path: prior.path }] : [])
          this.ambiguous.set(parsed.chronosId, [...all, here])
          this.snapshots.delete(parsed.chronosId)
        } else {
          this.snapshots.set(parsed.chronosId, { ...here, hash: hash(normalizeTaskXml(t.Xml)) })
        }
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
        name: t.TaskName, // #8
        nativePath: t.TaskPath
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
      name: t.TaskName, // #8: surface the real Task Scheduler name for unmanaged tasks
      // The folder too. Without it the caller cannot say which of two same-named tasks it meant,
      // and the adapter has nothing to locate an unmanaged task by.
      nativePath: t.TaskPath
    }
  }

  // Read ONE managed task's XML and hash its normalized form. '' if the task is gone.
  /** `at` is for a location the caller already holds but has not committed to the cache yet.
   *  Without it a post-write refresh hashes against a cache entry that does not exist yet, stores
   *  '', and then refuses the next write as drift — a refusal with nothing behind it. */
  private async taskXmlHash(chronosId: number, at?: NativeTaskRef): Promise<string> {
    // Read from where the task is. A cached entry always has a location; without one there is
    // nothing to export and '' is the right answer (guard treats it as gone).
    const known = at ?? this.snapshots.get(chronosId)
    if (!known) return ''
    const { stdout, exitCode } = await this.ps(
      `(Export-ScheduledTask -TaskName ${psQuote(known.name)} -TaskPath ${psQuote(known.path)})`
    )
    if (exitCode !== 0) return '' // task gone/unreadable → '' ≠ snapshot, so guard() refuses as drift
    return hash(normalizeTaskXml(stdout))
  }

  async detectDrift(): Promise<DriftResult> {
    for (const [id, entry] of this.snapshots) {
      if (entry.hash === undefined) continue // never snapshotted — nothing to compare
      const current = await this.taskXmlHash(id)
      if (current !== entry.hash) return { drifted: true, currentHash: current, expectedHash: entry.hash }
    }
    return { drifted: false, currentHash: '', expectedHash: '' }
  }

  // Hash-guard a single managed task before mutating it. Refuse on mismatch
  // (someone edited it externally since list()). Returns a drift WriteResult to
  // bail with, or null to proceed. (architect D6, spec §4.5)
  private async guard(chronosId: number): Promise<WriteResult | null> {
    const entry = this.snapshots.get(chronosId)
    // No hash means no snapshot to compare against — a task we located by marker but never read
    // the XML of, or one we just created. Same answer as before this cache existed: proceed, and
    // let the caller check existence. Reporting drift here would refuse writes on a task nobody
    // has edited.
    if (entry?.hash === undefined) return null
    const current = await this.taskXmlHash(chronosId)
    if (current === entry.hash) return null

    // An empty hash means the export failed, which is not the same as "the task changed". Ask the
    // marker where the task is now, so the message can say what actually happened. Without this
    // every one of these three situations arrives as the word "drift", and the two that are not
    // edits send the user looking for an edit.
    if (current === '') {
      // relocate, not locationOf: the cached entry is the one that just failed to export, so a
      // cache hit would hand back the same wrong answer and report every rename as a removal.
      const where = await this.relocate(chronosId).catch(() => undefined)
      const drift = { drifted: true, currentHash: '', expectedHash: entry.hash }
      if (where && (where.name !== entry.name || where.path !== entry.path)) {
        return {
          ok: false,
          reason: 'drift',
          drift,
          error: `the task was renamed or re-created as '${where.path}${where.name}' — reopen the schedules list to pick it up`
        }
      }
      return {
        ok: false,
        reason: 'drift',
        drift,
        // Deliberate wording: if the user renamed the task AND cleared its description, the marker
        // is gone and this is all we can honestly say. Claiming a rename we cannot see would be
        // worse than admitting we lost track of it.
        error: `the task is no longer where ChronosUI left it and carries no ChronosUI marker — it was removed, or its description was cleared`
      }
    }

    return { ok: false, reason: 'drift', drift: { drifted: true, currentHash: current, expectedHash: entry.hash } }
  }

  /**
   * Update the stored hash, keeping the location.
   *
   * Keeping it is the whole point. backend-switch's rebakeDescriptors and the compensating
   * re-adopt in jobs.service both call unadopt then adopt on an adapter they hold as
   * Pick<SchedulerAdapter,'unadopt'|'adopt'> — they cannot call list(), so the location they go on
   * to use is whatever this method leaves behind. Overwriting the entry wholesale would take out
   * every adopted job on the next database backend switch.
   *
   * `loc` is for a task we just created and therefore named ourselves; without it the existing
   * location stands, and failing that we fall back to the derived name, which is only ever right
   * for tasks ChronosUI created.
   */
  private async refreshSnapshot(chronosId: number, loc?: NativeTaskRef): Promise<void> {
    const known = this.snapshots.get(chronosId)
    const where = loc ?? (known ? { name: known.name, path: known.path } : { name: this.taskName(chronosId), path: this.folder })
    // Hand the location over rather than letting taskXmlHash look it up: for a job we just adopted
    // or created there is nothing in the cache yet, and the export would be skipped.
    this.snapshots.set(chronosId, { ...where, hash: await this.taskXmlHash(chronosId, where) })
  }

  /**
   * Where a managed task actually lives.
   *
   * The cache is filled by list(), but two callers never run it: backend-switch's
   * rebakeDescriptors and teardown build their work straight from the database, and the first one
   * holds the adapter as Pick<SchedulerAdapter,'unadopt'|'adopt'> so it structurally cannot. A
   * miss therefore falls back to finding the task by the marker in its Description — the same
   * thing list() identifies managed tasks by.
   *
   * Returns undefined when there is no such task. Throws when two tasks carry the same marker:
   * Export/Import in Task Scheduler duplicates a task along with its Description, and picking
   * either one would send every later write for that id somewhere arbitrary.
   */
  /** Forget what we knew and look the task up again by its marker. Used wherever the cached
   *  location has just been shown to be wrong — a cache hit alone returns the stale answer, which
   *  is how a rename would get reported as a removal. */
  private async relocate(chronosId: number): Promise<NativeTaskRef | undefined> {
    const prev = this.snapshots.get(chronosId)
    this.snapshots.delete(chronosId)
    const found = await this.locationOf(chronosId)
    // Carry the baseline across the move. The task has a new name, but it is the same task and we
    // have not re-read it — dropping the hash would make guard() wave the very next write through,
    // which is the retry the user makes right after being told to reopen the list.
    if (found && prev?.hash !== undefined) this.snapshots.set(chronosId, { ...found, hash: prev.hash })
    return found
  }

  private async locationOf(chronosId: number): Promise<NativeTaskRef | undefined> {
    const known = this.snapshots.get(chronosId)
    if (known) return { name: known.name, path: known.path }
    if (this.ambiguous.has(chronosId)) throw ambiguityError(chronosId, this.ambiguous.get(chronosId)!)
    await this.fillLocationsFromMarkers()
    const dup = this.ambiguous.get(chronosId)
    if (dup) throw ambiguityError(chronosId, dup)
    const found = this.snapshots.get(chronosId)
    return found ? { name: found.name, path: found.path } : undefined
  }

  /**
   * `locationOf` with the ambiguous case turned into a value.
   *
   * Every write path needs to tell three outcomes apart: found, gone, and "two tasks claim this
   * id". Only the third is an exception, and letting it propagate is how a single duplicate took
   * teardown and the backend switch down with it — neither had a try/catch, and the batch loops
   * they run promise the opposite ("per-job failures are collected rather than aborting").
   */
  private async whereIs(chronosId: number): Promise<{ at?: NativeTaskRef; ambiguous?: string }> {
    try {
      return { at: await this.locationOf(chronosId) }
    } catch (e) {
      return { ambiguous: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * One scan, every marker. rebakeDescriptors asks for N ids in a row; a scan per id would turn a
   * database backend switch into N full enumerations of the machine's scheduled tasks.
   *
   * Matching happens here rather than in the PowerShell filter. `-match 'chronos:5'` is a
   * substring test and would find chronos:50 — task-marker.ts anchors its regex for exactly that
   * reason, and reusing parseDescription keeps one rule instead of two that can drift apart.
   */
  private async fillLocationsFromMarkers(): Promise<void> {
    // Same range list() covers: our folder plus anything outside Microsoft's. Widening it would
    // break the claim that this costs what list() costs.
    const { stdout, exitCode } = await this.ps(`
# ${MARKER_SCAN_TAG}
$tasks = @(Get-ScheduledTask | Where-Object { ${this.taskScope()} })
$out = foreach ($t in $tasks) {
  [pscustomobject]@{ TaskName = $t.TaskName; TaskPath = $t.TaskPath; Description = $t.Description }
}
ConvertTo-Json -Compress -Depth 3 @($out)`)
    if (exitCode !== 0) return

    const seen = new Map<number, NativeTaskRef[]>()
    for (const t of parseTasksJson(stdout)) {
      const marker = parseDescription(t.Description)
      if (marker === null) continue
      const at = seen.get(marker.chronosId) ?? []
      at.push({ name: t.TaskName, path: t.TaskPath })
      seen.set(marker.chronosId, at)
    }

    for (const [id, where] of seen) {
      if (where.length > 1) {
        // Record it against that id and carry on. Throwing here would abort the whole scan, and
        // the scan is shared: teardown and a backend switch resolve every id from one pass, so a
        // duplicate belonging to job 2 would strand jobs 1 and 3 as well.
        this.ambiguous.set(id, where)
        this.snapshots.delete(id)
        continue
      }
      this.ambiguous.delete(id)
      const known = this.snapshots.get(id)
      // Keep any hash we already had: this scan does not read the XML, and dropping the hash would
      // silently disable the drift guard for that task.
      this.snapshots.set(id, { ...where[0], hash: known?.hash })
    }
  }

  // Run a mutating script on an existing managed task behind the drift guard.
  /**
   * Takes a builder rather than a finished script.
   *
   * Callers used to compose their PowerShell synchronously from taskName()+folder. Resolving the
   * real location is async, so either every caller awaits it and composes its own — four places to
   * get subtly different — or mutate resolves once and hands the answer over. This is the latter.
   */
  private async mutate(chronosId: number, build: (loc: NativeTaskRef) => string): Promise<WriteResult> {
    const { at: loc, ambiguous } = await this.whereIs(chronosId)
    if (ambiguous) return { ok: false, reason: 'error', error: ambiguous }
    if (!loc) return { ok: false, reason: 'error', error: noSuchTask(chronosId) }
    const g = await this.guard(chronosId)
    if (g) return g
    const { exitCode, stdout } = await this.ps(build(loc))
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
    return this.mutate(chronosId, (l) => `Enable-ScheduledTask -TaskName ${psQuote(l.name)} -TaskPath ${psQuote(l.path)} | Out-Null`)
  }

  async disableJob(chronosId: number): Promise<WriteResult> {
    return this.mutate(chronosId, (l) => `Disable-ScheduledTask -TaskName ${psQuote(l.name)} -TaskPath ${psQuote(l.path)} | Out-Null`)
  }

  // Read ONE managed task's current action + marker WITHOUT touching the drift
  // snapshot (so adopt/unadopt/update can inspect state without defeating the guard).
  /** `at` is for a task we have not adopted yet, whose identity only the caller knows. Everything
   *  else resolves through the cache (falling back to the marker scan). */
  private async readOne(chronosId: number, at?: NativeTaskRef): Promise<TaskReadback | null> {
    const first = at ?? (await this.locationOf(chronosId))
    const found = first ? await this.readAt(first) : null
    if (found || at) return found

    // Nothing at the location we had. That is not the same as "the task is gone": a cached name
    // goes stale the moment someone renames or moves the task, and releaseAll turns a null here
    // into `skipped` without consulting guard() — so teardown would report success while leaving
    // that task pointing at a schedmgr.exe about to be deleted. Every trigger after that fails in
    // silence. Drop the stale entry and look the task up by its marker before concluding anything.
    if (!first) return null
    const again = await this.relocate(chronosId)
    return again ? await this.readAt(again) : null
  }

  private async readAt(loc: NativeTaskRef): Promise<TaskReadback | null> {
    const script = `
$t = Get-ScheduledTask -TaskName ${psQuote(loc.name)} -TaskPath ${psQuote(loc.path)} -ErrorAction SilentlyContinue
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
      scheduleDescriptor: marker?.scheduleDescriptor ?? '',
      // What the marker recorded at adopt time, if anything. Absent on tasks adopted by a build
      // that predates the field — un-adopt then falls back to rebuilding a cmd /c action.
      recorded: marker?.original,
      recordedDescription: marker?.originalDescription,
      // The Description as it stands right now. On an unadopted task this is the owner's own text,
      // which adopt is about to overwrite.
      description: o.Description ?? '',
      // The two fields as the task holds them. `command` above is the flattened form the rest of
      // the app works in; this is what un-adopt needs to put back exactly.
      action: { execute: o.Execute ?? '', args: o.Arguments ?? '' }
    }
  }

  /**
   * Wrap an existing task where it already is.
   *
   * The task keeps its name and its folder; only its action and description change. That mirrors
   * what the crontab adapter does — the cron line stays on its own line and gains a `# chronos:`
   * comment — and it is what the dialog's "fully reversible" claims. Moving the task into
   * ChronosUI's folder under a derived name would also report success, and would destroy the
   * identity anything else on the machine refers to it by.
   *
   * Location comes from the cache first and the caller second. The two existing re-adopt paths
   * (backend-switch's rebakeDescriptors, the compensating re-adopt in jobs.service) run against
   * jobs that are already managed and pass no identity at all — requiring one breaks them, and
   * falling back to a derived name would keep the old bug for the database-switch path, which
   * touches every adopted job at once.
   */
  async adopt(chronosId: number, opts: AdoptOptions): Promise<WriteResult> {
    const g = await this.guard(chronosId)
    if (g) return g
    const here = await this.whereIs(chronosId)
    if (here.ambiguous) return { ok: false, reason: 'error', error: here.ambiguous }
    const loc = here.at ?? opts.native
    // Not the same as a managed task going missing: this job has never been adopted, so nothing
    // carries its marker yet, and the caller is the only one who could say which task to wrap.
    if (!loc) {
      return {
        ok: false,
        reason: 'error',
        error: `job ${chronosId}: cannot tell which scheduled task to adopt. No task identity was supplied, and no task carries this marker.`
      }
    }
    const cur = await this.readOne(chronosId, loc)
    if (!cur) return { ok: false, reason: 'error', error: taskUnreadable(chronosId, loc) }
    if (cur.adopted) return { ok: false, reason: 'error', error: `job ${chronosId} already adopted` }
    // Pre-check: refuse elevated (HighestAvailable) tasks before mutating (architect D4).
    const elevatedCheck = await this.ps(
      `$t = Get-ScheduledTask -TaskName ${psQuote(loc.name)} -TaskPath ${psQuote(loc.path)}\n` +
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
    // Stamp the marker as well as the action. An external task has no Description of ours, and
    // list() identifies managed tasks by that marker — without it the task would be wrapped and
    // then never recognised again. It also carries the action being replaced, which is the only
    // record un-adopt has of what to put back.
    const desc = buildDescription(chronosId, opts.scheduleExpr, cur.action, cur.description)
    const script = `
$t = Get-ScheduledTask -TaskName ${psQuote(loc.name)} -TaskPath ${psQuote(loc.path)}
$t.Actions = @(New-ScheduledTaskAction -Execute ${psQuote(opts.schedmgrPath)} -Argument ${psQuote(argString)})
$t.Description = ${psQuote(desc)}
Set-ScheduledTask -InputObject $t | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `adopt failed (${exitCode}): ${stdout}`.trim() }
    await this.refreshSnapshot(chronosId, loc)
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
        dbPath: this.opts.dbPath,
        // Rebuilding the options rather than forwarding the spec means every field has to be
        // copied by hand, and a field added to AdoptionSpec alone silently never arrives.
        native: spec.native
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
    const skipped: { chronosId: number; reason: 'no_match' | 'ambiguous' }[] = []

    for (const spec of specs) {
      // readOne first, and without a location: it relocates by marker when the cached name has
      // gone stale, which is how a task renamed since list() still gets released. An ambiguous
      // marker surfaces as a throw from that lookup — skipping that one id is right, aborting the
      // user's way out of the app is not.
      let cur
      try {
        cur = await this.readOne(spec.chronosId)
      } catch {
        skipped.push({ chronosId: spec.chronosId, reason: 'ambiguous' })
        continue
      }
      if (!cur) {
        skipped.push({ chronosId: spec.chronosId, reason: 'no_match' })
        continue
      }
      const { at: loc, ambiguous } = await this.whereIs(spec.chronosId)
      if (ambiguous) { skipped.push({ chronosId: spec.chronosId, reason: 'ambiguous' }); continue }
      if (!loc) { skipped.push({ chronosId: spec.chronosId, reason: 'no_match' }); continue }
      const name = loc.name
      // An adopted task also needs its action restored; a created one keeps the action it has.
      // Same fidelity as unadopt(): the two fields the task actually had, from the marker. The
      // flattened `cmd.exe /c <command>` rebuild is a different action — it changes how &, | and >
      // are handled and how the exit code comes back — and it stays only for tasks adopted before
      // the marker carried the fields. teardown is the last thing to touch this task; a restore
      // that lands wrong here is one nobody comes back to fix.
      const restoreAction = cur.adopted
        ? `$t.Actions = @(${
            cur.recorded
              ? `New-ScheduledTaskAction -Execute ${psQuote(cur.recorded.execute)} -Argument ${psQuote(cur.recorded.args)}`
              : `New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + spec.originalCommand)}`
          })\n`
        : ''
      // A task ChronosUI created has no description of anyone else's to put back; one it adopted
      // does, and clearing it would throw away the owner's own note along with our marker.
      const restoreDesc = cur.adopted ? (cur.recordedDescription ?? '') : ''
      const script = `
$t = Get-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(loc.path)}
${restoreAction}$t.Description = ${psQuote(restoreDesc)}
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
    // Same order as releaseAll and for the same reason: readOne resolves a stale cached name by
    // marker, and passing a location in would skip that.
    let cur
    try {
      cur = await this.readOne(chronosId)
    } catch (e) {
      return { ok: false, reason: 'error', error: e instanceof Error ? e.message : String(e) }
    }
    if (!cur || !cur.adopted) return { ok: false, reason: 'error', error: `job ${chronosId} not adopted` }
    const { at: loc, ambiguous } = await this.whereIs(chronosId)
    if (ambiguous) return { ok: false, reason: 'error', error: ambiguous }
    if (!loc) return { ok: false, reason: 'error', error: noSuchTask(chronosId) }
    // Put back the two fields the task actually had, when we recorded them at adopt time. The
    // fallback rebuild — cmd.exe /c <flattened command> — is not the same action: it changes how
    // &, | and > are handled and how the exit code comes back. It stays only for tasks adopted
    // before the marker carried this.
    const restore = cur.recorded
      ? `New-ScheduledTaskAction -Execute ${psQuote(cur.recorded.execute)} -Argument ${psQuote(cur.recorded.args)}`
      : `New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + originalCommand)}`
    // Hand the Description back as well. Leaving the marker on a task the user just took back
    // would tell every later list() the task is still ours, and leaves ChronosUI's text sitting in
    // the one field Task Scheduler gives a person to write in.
    const script = `
$t = Get-ScheduledTask -TaskName ${psQuote(loc.name)} -TaskPath ${psQuote(loc.path)}
$t.Actions = @(${restore})
$t.Description = ${psQuote(cur.recordedDescription ?? '')}
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
if (Get-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -ErrorAction SilentlyContinue) { Write-Error 'exists'; exit 1 }
$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${psQuote('/c ' + input.command)}
$t = ${triggerSpecToPwsh(spec)}
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description ${psQuote(desc)}
Register-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -InputObject $task | Out-Null
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
    if (!cur) return { ok: false, reason: 'error', error: noSuchTask(chronosId) }
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
    // Carry the recorded original forward. Rebuilding the description from the id and schedule
    // alone drops exec:/args:/desc:, so editing an adopted job's schedule would quietly cost it
    // the verbatim un-adopt it was promised.
    const newDesc = buildDescription(chronosId, triggerSpecToDescriptor(spec), cur.recorded, cur.recordedDescription)
    const { at: loc, ambiguous } = await this.whereIs(chronosId)
    if (ambiguous) return { ok: false, reason: 'error', error: ambiguous }
    if (!loc) return { ok: false, reason: 'error', error: noSuchTask(chronosId) }
    const script = `
$t = Get-ScheduledTask -TaskName ${psQuote(loc.name)} -TaskPath ${psQuote(loc.path)}
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
    const { at: loc, ambiguous } = await this.whereIs(chronosId)
    if (ambiguous) return { ok: false, reason: 'error', error: ambiguous }
    if (!loc) return { ok: false, reason: 'error', error: noSuchTask(chronosId) }
    const g = await this.guard(chronosId)
    if (g) return g
    const { exitCode, stdout } = await this.ps(
      `Unregister-ScheduledTask -TaskName ${psQuote(loc.name)} -TaskPath ${psQuote(loc.path)} -Confirm:$false`
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
if (Get-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -Confirm:$false
}
$a = New-ScheduledTaskAction -Execute ${psQuote(this.opts.schedmgrPath)} -Argument ${psQuote(argString)}
$t = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${windowMin})
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $a -Trigger $t -Settings $s -Principal $p -Description 'ChronosUI notify-flush'
Register-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -InputObject $task | Out-Null
`.trim()
    const { exitCode, stdout } = await this.ps(script)
    if (exitCode !== 0) return { ok: false, reason: 'error', error: `install flush failed (${exitCode}): ${stdout}`.trim() }
    return { ok: true }
  }

  async removeFlushEntry(): Promise<WriteResult> {
    const name = TaskSchedulerAdapter.FLUSH_TASK
    const script = `
if (Get-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(this.folder)} -Confirm:$false
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

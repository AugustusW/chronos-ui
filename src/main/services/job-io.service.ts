// SPDX-License-Identifier: Apache-2.0
import { parse as parseYamlDoc, stringify as stringifyYaml } from 'yaml'
import type { Job } from '../db/schema'
import type { WriteResult } from '../scheduler/types'
import type {
  CreateJobInput, UpdateJobChanges, YamlJobEntry, JobDiffEntry,
  ExportYamlResult, ImportPreviewResult, ImportApplyResult
} from '../../shared/ipc-contract'

/** A job → the shape it's written to YAML as. Deliberately close to CreateJobInput (see
 *  YamlJobEntry's own doc comment for the full field-selection rationale) — `id`, `source`,
 *  `platform`, `adopted`, and every run-history/runtime field are excluded: `adopted` in particular
 *  can't safely round-trip (it means "this DB row wraps a pre-existing external cron line", which
 *  import has no way to re-establish), so an imported job is always created fresh, non-adopted.
 *  Optional fields are omitted entirely when at their default, keeping a plain "New job" export terse. */
export function jobToYamlEntry(job: Job): YamlJobEntry {
  const entry: YamlJobEntry = { name: job.name, scheduleExpr: job.scheduleExpr, command: job.command }
  if (job.workingDir) entry.workingDir = job.workingDir
  if (job.env) entry.env = job.env
  if (job.timeoutSec != null) entry.timeoutSec = job.timeoutSec
  if (job.category) entry.category = job.category
  if (job.notifyOnFailure) entry.notifyOnFailure = job.notifyOnFailure
  if (!job.enabled) entry.enabled = false // omitted when true (the default) — same terseness rule
  return entry
}

export function serializeJobsToYaml(jobs: Job[]): string {
  return stringifyYaml(jobs.map(jobToYamlEntry))
}

export type ParseYamlResult = { ok: true; entries: YamlJobEntry[] } | { ok: false; error: string }

function isValidEntry(v: unknown): v is YamlJobEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' && o.name.length > 0 &&
    typeof o.scheduleExpr === 'string' && o.scheduleExpr.length > 0 &&
    typeof o.command === 'string' && o.command.length > 0 &&
    (o.workingDir === undefined || typeof o.workingDir === 'string') &&
    (o.env === undefined || (typeof o.env === 'object' && o.env !== null && !Array.isArray(o.env))) &&
    (o.timeoutSec === undefined || (typeof o.timeoutSec === 'number' && Number.isInteger(o.timeoutSec))) &&
    (o.category === undefined || typeof o.category === 'string') &&
    (o.notifyOnFailure === undefined || typeof o.notifyOnFailure === 'boolean') &&
    (o.enabled === undefined || typeof o.enabled === 'boolean')
  )
}

/** Parses + validates a YAML job list. Pure (no fs/dialog) so it unit-tests on plain strings. */
export function parseJobsYaml(text: string): ParseYamlResult {
  let parsed: unknown
  try {
    parsed = parseYamlDoc(text)
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'YAML root must be a list of jobs (see README.md\'s YAML job schema)' }
  if (parsed.length === 0) return { ok: false, error: 'No jobs found in file' }
  const entries: YamlJobEntry[] = []
  for (let i = 0; i < parsed.length; i++) {
    if (!isValidEntry(parsed[i])) {
      return { ok: false, error: `Entry ${i + 1} is missing or has an invalid "name" / "scheduleExpr" / "command"` }
    }
    entries.push(parsed[i] as YamlJobEntry)
  }
  return { ok: true, entries }
}

/** One comparator per round-trippable field — used both to detect "did anything change" and to
 *  report WHICH fields changed for the import preview UI. Each treats an omitted YAML field as the
 *  same default create()/the schema itself would use, so a terse export (see jobToYamlEntry) compares
 *  as unchanged against the job it came from, not as N spurious diffs. */
const FIELD_COMPARATORS: Record<string, (entry: YamlJobEntry, job: Job) => boolean> = {
  scheduleExpr: (e, j) => e.scheduleExpr === j.scheduleExpr,
  command: (e, j) => e.command === j.command,
  workingDir: (e, j) => (e.workingDir ?? null) === (j.workingDir ?? null),
  timeoutSec: (e, j) => (e.timeoutSec ?? null) === (j.timeoutSec ?? null),
  category: (e, j) => (e.category ?? null) === (j.category ?? null),
  notifyOnFailure: (e, j) => (e.notifyOnFailure ?? false) === j.notifyOnFailure,
  enabled: (e, j) => (e.enabled ?? true) === j.enabled,
  env: (e, j) => JSON.stringify(e.env ?? null) === JSON.stringify(j.env ?? null)
}

/** Pure diff: classifies each incoming YAML entry as 'new' (no existing job with that name),
 *  'changed' (name matches but ≥1 FIELD_COMPARATORS differs), or 'unchanged'. Matches by `name`
 *  (first-wins on duplicates — job names aren't unique in the schema; this is the best available
 *  cross-session identity key since the YAML format deliberately carries no DB id, see
 *  jobToYamlEntry's doc comment). Never mutates anything — the caller decides whether/how to apply. */
export function diffImportedJobs(entries: YamlJobEntry[], existingJobs: Job[]): JobDiffEntry[] {
  const byName = new Map<string, Job>()
  for (const job of existingJobs) if (!byName.has(job.name)) byName.set(job.name, job)

  return entries.map((entry): JobDiffEntry => {
    const existing = byName.get(entry.name)
    if (!existing) return { kind: 'new', entry }
    const changedFields = Object.entries(FIELD_COMPARATORS)
      .filter(([, cmp]) => !cmp(entry, existing))
      .map(([field]) => field)
    if (changedFields.length === 0) return { kind: 'unchanged', entry, existingId: existing.id }
    return { kind: 'changed', entry, existingId: existing.id, changedFields }
  })
}

function toCreateInput(entry: YamlJobEntry): CreateJobInput {
  return {
    name: entry.name, scheduleExpr: entry.scheduleExpr, command: entry.command,
    workingDir: entry.workingDir, env: entry.env, timeoutSec: entry.timeoutSec,
    category: entry.category, notifyOnFailure: entry.notifyOnFailure
  }
}
function toUpdateChanges(entry: YamlJobEntry): UpdateJobChanges {
  return {
    name: entry.name, scheduleExpr: entry.scheduleExpr, command: entry.command,
    workingDir: entry.workingDir, env: entry.env, timeoutSec: entry.timeoutSec,
    category: entry.category, notifyOnFailure: entry.notifyOnFailure
  }
}

export interface JobIoServiceDeps {
  listJobs: () => Promise<Job[]>
  // JobsService's own create/update/enable/disable (jobs.service.ts) — reused so import goes
  // through the SAME native-scheduler-adapter path "New job" / the job editor already use, rather
  // than writing DB rows directly and leaving the crontab/Task Scheduler side unwrapped.
  createJob: (input: CreateJobInput) => Promise<WriteResult & { job?: Job }>
  updateJob: (id: number, changes: UpdateJobChanges) => Promise<WriteResult & { job?: Job }>
  enableJob: (id: number) => Promise<WriteResult>
  disableJob: (id: number) => Promise<WriteResult>
  showSaveDialog: (opts: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog: (opts: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; filePaths: string[] }>
  readFile: (path: string) => string
  writeFile: (path: string, content: string) => void
}

export interface JobIoService {
  /** `jobIds` omitted = export every job; otherwise only the given ids (JobDetailView's
   *  "Export this job"). */
  exportJobs(jobIds?: number[]): Promise<ExportYamlResult>
  previewImport(): Promise<ImportPreviewResult>
  applyImport(entries: YamlJobEntry[]): Promise<ImportApplyResult>
}

const YAML_FILE_FILTER = [{ name: 'YAML', extensions: ['yaml', 'yml'] }]

async function applyOne(
  diff: JobDiffEntry,
  deps: Pick<JobIoServiceDeps, 'createJob' | 'updateJob' | 'enableJob' | 'disableJob'>
): Promise<{ action: 'created' | 'updated' | 'skipped' | 'error'; error?: string }> {
  if (diff.kind === 'unchanged') return { action: 'skipped' }
  const wantEnabled = diff.entry.enabled ?? true

  if (diff.kind === 'new') {
    const r = await deps.createJob(toCreateInput(diff.entry))
    if (!r.ok || !r.job) return { action: 'error', error: r.error ?? 'create failed' }
    if (!wantEnabled) {
      const d = await deps.disableJob(r.job.id)
      if (!d.ok) return { action: 'error', error: d.error ?? 'created but failed to set disabled' }
    }
    return { action: 'created' }
  }

  // 'changed' — existingId is always set for this kind (diffImportedJobs invariant).
  const id = diff.existingId as number
  const r = await deps.updateJob(id, toUpdateChanges(diff.entry))
  if (!r.ok) return { action: 'error', error: r.error ?? 'update failed' }
  // Always reconciles enabled state (idempotent on the adapter side) rather than only when
  // changedFields includes 'enabled' — one fewer thing this function needs to trust from the diff.
  const w = wantEnabled ? await deps.enableJob(id) : await deps.disableJob(id)
  if (!w.ok) return { action: 'error', error: w.error ?? 'updated but failed to set enabled state' }
  return { action: 'updated' }
}

export function createJobIoService(deps: JobIoServiceDeps): JobIoService {
  return {
    async exportJobs(jobIds) {
      const all = await deps.listJobs()
      const selected = jobIds ? all.filter((j) => jobIds.includes(j.id)) : all
      if (selected.length === 0) return { status: 'error', error: 'No jobs to export' }
      const { canceled, filePath } = await deps.showSaveDialog({
        defaultPath: 'chronos-jobs.yaml',
        filters: YAML_FILE_FILTER
      })
      if (canceled || !filePath) return { status: 'canceled' }
      try {
        deps.writeFile(filePath, serializeJobsToYaml(selected))
        return { status: 'ok', path: filePath }
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },

    async previewImport() {
      const { canceled, filePaths } = await deps.showOpenDialog({ filters: YAML_FILE_FILTER })
      if (canceled || filePaths.length === 0) return { status: 'canceled' }
      const filePath = filePaths[0]
      let text: string
      try {
        text = deps.readFile(filePath)
      } catch (err) {
        return { status: 'error', error: `Couldn't read file: ${err instanceof Error ? err.message : String(err)}` }
      }
      const parsed = parseJobsYaml(text)
      if (!parsed.ok) return { status: 'error', error: parsed.error }
      const existing = await deps.listJobs()
      const entries = diffImportedJobs(parsed.entries, existing)
      const fileName = filePath.split(/[/\\]/).pop() ?? filePath
      return { status: 'ok', preview: { fileName, entries } }
    },

    async applyImport(entries) {
      // Re-diffs against CURRENT state (not whatever the preview saw) — the only source of truth
      // for "new vs changed vs unchanged" at the moment of applying, so a DB change in the gap
      // between preview and confirm (another edit, a delete) is still handled correctly rather than
      // trusting a possibly-stale client-held classification.
      const existing = await deps.listJobs()
      const diffs = diffImportedJobs(entries, existing)
      let created = 0
      let updated = 0
      const errors: string[] = []
      for (const diff of diffs) {
        const r = await applyOne(diff, deps)
        if (r.action === 'created') created++
        else if (r.action === 'updated') updated++
        else if (r.action === 'error') errors.push(`${diff.entry.name}: ${r.error}`)
      }
      return { ok: errors.length === 0, created, updated, errors }
    }
  }
}

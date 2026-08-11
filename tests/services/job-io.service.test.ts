// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import {
  jobToYamlEntry, serializeJobsToYaml, parseJobsYaml, diffImportedJobs, createJobIoService,
  type JobIoServiceDeps
} from '../../src/main/services/job-io.service'
import type { Job } from '../../src/main/db/schema'

function job(over: Partial<Job> = {}): Job {
  return {
    id: 1, name: 'Backup', source: 'native_cron', platform: 'darwin',
    scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh',
    workingDir: null, env: null, enabled: true, adopted: false,
    timeoutSec: null, category: null, notifyOnFailure: false,
    lastRunAt: null, lastResult: null,
    createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    ...over
  }
}

describe('jobToYamlEntry', () => {
  it('a plain default job exports just name/scheduleExpr/command (every optional field omitted)', () => {
    expect(jobToYamlEntry(job())).toEqual({ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' })
  })
  it('includes non-default optional fields', () => {
    const j = job({ workingDir: '/tmp', env: { FOO: 'bar' }, timeoutSec: 60, category: 'db', notifyOnFailure: true, enabled: false })
    expect(jobToYamlEntry(j)).toEqual({
      name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh',
      workingDir: '/tmp', env: { FOO: 'bar' }, timeoutSec: 60, category: 'db', notifyOnFailure: true, enabled: false
    })
  })
  it('omits enabled when true (the default) but includes it when false', () => {
    expect(jobToYamlEntry(job({ enabled: true }))).not.toHaveProperty('enabled')
    expect(jobToYamlEntry(job({ enabled: false }))).toHaveProperty('enabled', false)
  })
  it('never includes id/source/platform/adopted/run-history fields — see the doc comment for why', () => {
    const entry = jobToYamlEntry(job({ adopted: true }))
    expect(entry).not.toHaveProperty('id')
    expect(entry).not.toHaveProperty('adopted')
    expect(entry).not.toHaveProperty('source')
    expect(entry).not.toHaveProperty('platform')
  })
})

describe('serializeJobsToYaml / parseJobsYaml round-trip', () => {
  it('serializes N jobs and parses back to equivalent entries', () => {
    const jobs = [job({ id: 1, name: 'A' }), job({ id: 2, name: 'B', category: 'infra' })]
    const yaml = serializeJobsToYaml(jobs)
    const parsed = parseJobsYaml(yaml)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.entries).toEqual(jobs.map(jobToYamlEntry))
  })
})

describe('parseJobsYaml', () => {
  it('rejects invalid YAML syntax', () => {
    const r = parseJobsYaml('not: valid: yaml: [')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Invalid YAML')
  })
  it('rejects a non-list root', () => {
    const r = parseJobsYaml('name: Backup\nscheduleExpr: "0 3 * * *"\ncommand: x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('list of jobs')
  })
  it('rejects an empty list', () => {
    const r = parseJobsYaml('[]')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('No jobs found')
  })
  it('rejects an entry missing a required field, reporting its 1-based position', () => {
    const r = parseJobsYaml('- name: A\n  scheduleExpr: "0 3 * * *"\n  command: x\n- name: B\n  scheduleExpr: "0 4 * * *"\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Entry 2')
  })
  it('accepts a well-formed list with optional fields', () => {
    const r = parseJobsYaml('- name: A\n  scheduleExpr: "0 3 * * *"\n  command: x\n  timeoutSec: 30\n  enabled: false\n')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entries).toEqual([{ name: 'A', scheduleExpr: '0 3 * * *', command: 'x', timeoutSec: 30, enabled: false }])
  })
})

describe('diffImportedJobs', () => {
  it('classifies an entry with no matching existing job as "new"', () => {
    const [d] = diffImportedJobs([{ name: 'NewJob', scheduleExpr: '* * * * *', command: 'x' }], [])
    expect(d.kind).toBe('new')
    expect(d.existingId).toBeUndefined()
  })
  it('classifies an exact-match entry (same name, same fields) as "unchanged"', () => {
    const existing = [job({ id: 5, name: 'Backup' })]
    const [d] = diffImportedJobs([jobToYamlEntry(existing[0])], existing)
    expect(d).toEqual({ kind: 'unchanged', entry: jobToYamlEntry(existing[0]), existingId: 5 })
  })
  it('classifies a name match with a different command as "changed", reporting which field(s) differ', () => {
    const existing = [job({ id: 5, name: 'Backup', command: '/old.sh' })]
    const [d] = diffImportedJobs([{ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/new.sh' }], existing)
    expect(d.kind).toBe('changed')
    expect(d.existingId).toBe(5)
    expect(d.changedFields).toEqual(['command'])
  })
  it('reports every differing field, not just the first', () => {
    const existing = [job({ id: 5, name: 'Backup', command: '/old.sh', category: 'db' })]
    const [d] = diffImportedJobs([{ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/new.sh', category: 'infra' }], existing)
    expect(d.changedFields).toEqual(expect.arrayContaining(['command', 'category']))
    expect(d.changedFields).toHaveLength(2)
  })
  it('a terse export (optional fields omitted at their default) diffs as unchanged against the job it came from', () => {
    const existing = [job({ id: 5, name: 'Backup', enabled: true, notifyOnFailure: false, workingDir: null })]
    const [d] = diffImportedJobs([jobToYamlEntry(existing[0])], existing)
    expect(d.kind).toBe('unchanged')
  })
  it('matches by name — first-wins on duplicate existing names (documented limitation)', () => {
    const existing = [job({ id: 1, name: 'Dup', command: '/a.sh' }), job({ id: 2, name: 'Dup', command: '/b.sh' })]
    const [d] = diffImportedJobs([{ name: 'Dup', scheduleExpr: '0 3 * * *', command: '/a.sh' }], existing)
    expect(d.existingId).toBe(1)
    expect(d.kind).toBe('unchanged')
  })
  it('env is compared by deep value, not reference', () => {
    const existing = [job({ id: 5, name: 'Backup', env: { A: '1', B: '2' } })]
    const [unchanged] = diffImportedJobs([{ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh', env: { A: '1', B: '2' } }], existing)
    expect(unchanged.kind).toBe('unchanged')
    const [changed] = diffImportedJobs([{ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh', env: { A: '1', B: 'DIFFERENT' } }], existing)
    expect(changed.kind).toBe('changed')
    expect(changed.changedFields).toEqual(['env'])
  })
})

function fakeDeps(over: Partial<JobIoServiceDeps> = {}): JobIoServiceDeps {
  return {
    listJobs: async () => [],
    createJob: async () => ({ ok: true, job: job({ id: 99 }) }),
    updateJob: async () => ({ ok: true, job: job() }),
    enableJob: async () => ({ ok: true }),
    disableJob: async () => ({ ok: true }),
    showSaveDialog: async () => ({ canceled: true }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    readFile: () => '',
    writeFile: () => {},
    ...over
  }
}

describe('createJobIoService.exportJobs', () => {
  it('returns "canceled" when the save dialog is dismissed, without writing a file', async () => {
    const writeFile = vi.fn()
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [job()], writeFile }))
    const r = await svc.exportJobs()
    expect(r).toEqual({ status: 'canceled' })
    expect(writeFile).not.toHaveBeenCalled()
  })
  it('writes serialized YAML to the chosen path and reports it', async () => {
    let written: { path?: string; content?: string } = {}
    const svc = createJobIoService(fakeDeps({
      listJobs: async () => [job({ name: 'A' }), job({ id: 2, name: 'B' })],
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/jobs.yaml' }),
      writeFile: (p, c) => { written = { path: p, content: c } }
    }))
    const r = await svc.exportJobs()
    expect(r).toEqual({ status: 'ok', path: '/tmp/jobs.yaml' })
    expect(written.path).toBe('/tmp/jobs.yaml')
    expect(written.content).toContain('name: A')
    expect(written.content).toContain('name: B')
  })
  it('filters to only the given jobIds when provided', async () => {
    let written = ''
    const svc = createJobIoService(fakeDeps({
      listJobs: async () => [job({ id: 1, name: 'A' }), job({ id: 2, name: 'B' })],
      showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/jobs.yaml' }),
      writeFile: (_p, c) => { written = c }
    }))
    await svc.exportJobs([2])
    expect(written).toContain('name: B')
    expect(written).not.toContain('name: A')
  })
  it('errors when the jobIds filter matches nothing, without opening a dialog', async () => {
    const showSaveDialog = vi.fn(async () => ({ canceled: true }))
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [job({ id: 1 })], showSaveDialog }))
    const r = await svc.exportJobs([999])
    expect(r).toEqual({ status: 'error', error: 'No jobs to export' })
    expect(showSaveDialog).not.toHaveBeenCalled()
  })
  it('surfaces a write failure as a status:error result', async () => {
    const svc = createJobIoService(fakeDeps({
      listJobs: async () => [job()],
      showSaveDialog: async () => ({ canceled: false, filePath: '/no/such/dir/x.yaml' }),
      writeFile: () => { throw new Error('EACCES') }
    }))
    const r = await svc.exportJobs()
    expect(r).toEqual({ status: 'error', error: 'EACCES' })
  })
})

describe('createJobIoService.previewImport', () => {
  it('returns "canceled" when the open dialog is dismissed', async () => {
    const svc = createJobIoService(fakeDeps())
    expect(await svc.previewImport()).toEqual({ status: 'canceled' })
  })
  it('reads + parses + diffs the chosen file and returns a preview with its filename', async () => {
    const svc = createJobIoService(fakeDeps({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/home/u/exports/jobs.yaml'] }),
      readFile: () => '- name: NewJob\n  scheduleExpr: "* * * * *"\n  command: x\n',
      listJobs: async () => []
    }))
    const r = await svc.previewImport()
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.preview.fileName).toBe('jobs.yaml')
      expect(r.preview.entries).toEqual([{ kind: 'new', entry: { name: 'NewJob', scheduleExpr: '* * * * *', command: 'x' } }])
    }
  })
  it('surfaces a file-read failure', async () => {
    const svc = createJobIoService(fakeDeps({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/gone.yaml'] }),
      readFile: () => { throw new Error('ENOENT') }
    }))
    const r = await svc.previewImport()
    expect(r.status).toBe('error')
  })
  it('surfaces a parse failure (invalid YAML content)', async () => {
    const svc = createJobIoService(fakeDeps({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/bad.yaml'] }),
      readFile: () => 'not a list'
    }))
    const r = await svc.previewImport()
    expect(r.status).toBe('error')
  })
})

describe('createJobIoService.applyImport', () => {
  it('creates a "new" entry via deps.createJob (not a raw DB write)', async () => {
    const createJob = vi.fn(async () => ({ ok: true, job: job({ id: 99 }) }))
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [], createJob }))
    const r = await svc.applyImport([{ name: 'A', scheduleExpr: '* * * * *', command: 'x' }])
    expect(r).toEqual({ ok: true, created: 1, updated: 0, errors: [] })
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ name: 'A' }))
  })
  it('disables a newly-created job when the entry says enabled:false', async () => {
    const disableJob = vi.fn(async () => ({ ok: true }))
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [], createJob: async () => ({ ok: true, job: job({ id: 42 }) }), disableJob }))
    await svc.applyImport([{ name: 'A', scheduleExpr: '* * * * *', command: 'x', enabled: false }])
    expect(disableJob).toHaveBeenCalledWith(42)
  })
  it('updates a "changed" entry via deps.updateJob, keyed by the existing job\'s id', async () => {
    const updateJob = vi.fn(async () => ({ ok: true, job: job({ id: 5 }) }))
    const existing = job({ id: 5, name: 'Backup', command: '/old.sh' })
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [existing], updateJob }))
    const r = await svc.applyImport([{ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/new.sh' }])
    expect(r).toEqual({ ok: true, created: 0, updated: 1, errors: [] })
    expect(updateJob).toHaveBeenCalledWith(5, expect.objectContaining({ command: '/new.sh' }))
  })
  it('skips an "unchanged" entry entirely — no create/update/enable/disable call', async () => {
    const createJob = vi.fn()
    const updateJob = vi.fn()
    const enableJob = vi.fn()
    const disableJob = vi.fn()
    const existing = job({ id: 5, name: 'Backup' })
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [existing], createJob, updateJob, enableJob, disableJob }))
    const r = await svc.applyImport([jobToYamlEntry(existing)])
    expect(r).toEqual({ ok: true, created: 0, updated: 0, errors: [] })
    expect(createJob).not.toHaveBeenCalled()
    expect(updateJob).not.toHaveBeenCalled()
  })
  it('collects a create failure as an error without throwing, and keeps processing the rest', async () => {
    const svc = createJobIoService(fakeDeps({
      listJobs: async () => [],
      createJob: async (input) => (input.name === 'Bad' ? { ok: false, error: 'adapter rejected' } : { ok: true, job: job({ id: 7, name: input.name }) })
    }))
    const r = await svc.applyImport([
      { name: 'Bad', scheduleExpr: '* * * * *', command: 'x' },
      { name: 'Good', scheduleExpr: '* * * * *', command: 'y' }
    ])
    expect(r.ok).toBe(false)
    expect(r.created).toBe(1)
    expect(r.errors).toEqual(['Bad: adapter rejected'])
  })
  it('re-diffs against CURRENT state at apply time, not a stale client-held classification', async () => {
    // Even though this entry LOOKS unchanged relative to a job that existed at preview time, the
    // job list handed to applyImport (via listJobs) reflects it having been renamed away — so this
    // entry is (correctly) treated as brand new, not "changed" against a job that no longer matches.
    const createJob = vi.fn(async () => ({ ok: true, job: job({ id: 50 }) }))
    const svc = createJobIoService(fakeDeps({ listJobs: async () => [job({ id: 5, name: 'RenamedAway' })], createJob }))
    const r = await svc.applyImport([{ name: 'Backup', scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' }])
    expect(r.created).toBe(1)
    expect(createJob).toHaveBeenCalled()
  })
})

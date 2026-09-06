// SPDX-License-Identifier: Apache-2.0
// restoreToScheduler wired to the REAL CrontabAdapter (only `crontab` itself is faked).
//
// Why this file exists: every other test of this path uses a fake adapter whose updateJob is
// `async () => ({ok: true})`. That fake cannot express the two things the real adapter actually
// does — recompute the enabled prefix from the CURRENT crontab line, and refuse an in-place
// command change on an adopted job — so it reported success for two restores that changed nothing
// and for one that could never work. Both defects were invisible until the real adapter was in
// the loop.
import { describe, it, expect } from 'vitest'
import { makeTestDb } from '../db/helpers'
import { createRepositories } from '../../src/main/db/repositories'
import { createJobsService } from '../../src/main/services/jobs.service'
import { CrontabAdapter, type ExecFn } from '../../src/main/scheduler/crontab.adapter'

const SCHEDMGR = '/opt/chronos/schedmgr'
const DB = '/tmp/chronos.db'

function makeFakeExec(initial: string) {
  const state = { text: initial }
  const exec: ExecFn = async (cmd, args, stdin) => {
    if (cmd === 'crontab' && args[0] === '-l') return { stdout: state.text, exitCode: 0 }
    if (cmd === 'crontab' && args[0] === '-') {
      state.text = stdin ?? ''
      return { stdout: '', exitCode: 0 }
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  return { exec, state }
}

/** A service over a real CrontabAdapter, with one DB job whose id matches the crontab marker. */
async function harness(crontab: string, job: { scheduleExpr: string; command: string; enabled?: boolean; adopted?: boolean }) {
  const h = makeTestDb()
  const repos = createRepositories(h)
  const { exec, state } = makeFakeExec(crontab)
  const adapter = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
  const service = createJobsService({ repos, adapter, platform: 'darwin', schedmgrPath: SCHEDMGR, dbPath: DB })
  const created = await repos.jobs.create({
    name: 'backup', source: 'native_cron', platform: 'darwin',
    scheduleExpr: job.scheduleExpr, command: job.command,
    enabled: job.enabled ?? true, adopted: job.adopted ?? false
  })
  return { h, service, state, jobId: created.id }
}

describe('restoreToScheduler against the real crontab adapter', () => {
  it('rewrites a command someone changed outside the app', async () => {
    const { service, state, jobId } = await harness(
      '# chronos:1\n0 3 * * * /usr/bin/EVIL.sh\n',
      { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' }
    )
    const r = await service.restoreToScheduler(jobId)
    expect(r.ok).toBe(true)
    expect(state.text).toContain('/usr/bin/backup.sh')
    expect(state.text).not.toContain('EVIL')
  })

  it('re-enables a line someone commented out', async () => {
    // The adapter rebuilds the '#' prefix from the CURRENT line, so sending schedule+command alone
    // leaves a disabled line disabled — and the restore would report success having done nothing.
    const { service, state, jobId } = await harness(
      '# chronos:1\n#0 3 * * * /usr/bin/backup.sh\n',
      { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh', enabled: true }
    )
    const r = await service.restoreToScheduler(jobId)
    expect(r.ok).toBe(true)
    expect(state.text).toContain('\n0 3 * * * /usr/bin/backup.sh')
    expect(state.text).not.toContain('#0 3 * * *')
  })

  it('disables a line someone enabled outside the app', async () => {
    const { service, state, jobId } = await harness(
      '# chronos:1\n0 3 * * * /usr/bin/backup.sh\n',
      { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh', enabled: false }
    )
    expect((await service.restoreToScheduler(jobId)).ok).toBe(true)
    expect(state.text).toContain('#0 3 * * * /usr/bin/backup.sh')
  })

  it('restores a schedule-only drift on an ADOPTED job', async () => {
    // Forwarding `command` unconditionally would trip the adapter's "cannot change an adopted job's
    // command" guard on a field nobody touched, and the error would name the wrong thing.
    const wrapped = `*/5 * * * * '${SCHEDMGR}' run 1 --db '${DB}' -- '/usr/bin/backup.sh'`
    const { service, state, jobId } = await harness(
      `# chronos:1\n${wrapped}\n`,
      { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh', adopted: true }
    )
    const r = await service.restoreToScheduler(jobId)
    expect(r.ok).toBe(true)
    expect(state.text).toContain('0 3 * * *')
    expect(state.text).toContain(`'${SCHEDMGR}' run 1`) // wrapper intact
  })

  it('refuses — and says so — when an adopted job\'s command itself drifted', async () => {
    const wrapped = `0 3 * * * '${SCHEDMGR}' run 1 --db '${DB}' -- '/usr/bin/EVIL.sh'`
    const { service, state, jobId } = await harness(
      `# chronos:1\n${wrapped}\n`,
      { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh', adopted: true }
    )
    const r = await service.restoreToScheduler(jobId)
    expect(r.ok).toBe(false)
    expect('error' in r && r.error).toContain('adopted job')
    expect(state.text).toContain('EVIL') // unchanged: a refusal must not half-apply
  })

  it('is a no-op that still succeeds when nothing drifted', async () => {
    const { service, state, jobId } = await harness(
      '# chronos:1\n0 3 * * * /usr/bin/backup.sh\n',
      { scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' }
    )
    const before = state.text
    expect((await service.restoreToScheduler(jobId)).ok).toBe(true)
    expect(state.text).toBe(before)
  })
})

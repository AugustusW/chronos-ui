// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { CrontabAdapter, type ExecFn } from '../../src/main/scheduler/crontab.adapter'
import type { AdoptionSpec } from '../../src/main/scheduler/types'

// fakeExec simulates `crontab -l` (read) and captures `crontab -` (write). It NEVER touches the
// real user crontab. `state.text` is the current crontab; writes (crontab - with stdin) update it.
function makeFakeExec(initial: string) {
  const state = { text: initial, writes: [] as string[] }
  const exec: ExecFn = async (cmd, args, stdin) => {
    if (cmd === 'crontab' && args.length === 1 && args[0] === '-l') {
      return { stdout: state.text, exitCode: 0 }
    }
    if (cmd === 'crontab' && args.length === 1 && args[0] === '-') {
      state.text = stdin ?? ''
      state.writes.push(state.text)
      return { stdout: '', exitCode: 0 }
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
  }
  return { exec, state }
}

const SCHEDMGR = '/opt/chronos/schedmgr'
const DB = '/Users/me/Library/Application Support/ChronosUI/chronos.db'

describe('CrontabAdapter.list', () => {
  it('returns managed (adopted) + unmanaged jobs with the original command unquoted', async () => {
    const initial = [
      '0 3 * * * /usr/bin/python3 backup.py',
      '# chronos:42',
      `*/5 * * * * ${SCHEDMGR} run 42 --db ${DB} -- 'echo hi && date'`,
      ''
    ].join('\n')
    const { exec } = makeFakeExec(initial)
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    const jobs = await a.list()

    const unmanaged = jobs.find((j) => j.chronosId === null)!
    expect(unmanaged.adopted).toBe(false)
    expect(unmanaged.command).toBe('/usr/bin/python3 backup.py')

    const managed = jobs.find((j) => j.chronosId === 42)!
    expect(managed.adopted).toBe(true)
    expect(managed.enabled).toBe(true)
    expect(managed.command).toBe('echo hi && date') // ORIGINAL command, unquoted from after `--`
  })
})

describe('CrontabAdapter write-back + drift', () => {
  it('detectDrift reports no drift right after a read, drift after an external change', async () => {
    const { exec, state } = makeFakeExec('0 3 * * * a\n')
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list() // snapshot taken
    expect((await a.detectDrift()).drifted).toBe(false)
    state.text = '0 9 * * * b\n' // external edit
    expect((await a.detectDrift()).drifted).toBe(true)
  })

  it('a mutation refuses (WriteResult.reason=drift) if the crontab changed since the last read', async () => {
    const initial = '# chronos:42\n*/5 * * * * ' + SCHEDMGR + " run 42 --db " + DB + " -- 'echo hi'\n"
    const { exec, state } = makeFakeExec(initial)
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    state.text = state.text + '\n0 1 * * * sneaky\n' // external edit between read and write
    const res = await a.disableJob(42)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('drift')
    expect(state.writes).toHaveLength(0) // nothing was written
  })
})

describe('CrontabAdapter adopt/unadopt', () => {
  it('adopt rewrites the line to the schedmgr form with the original shell-quoted as one arg', async () => {
    const initial = '0 3 * * * backup.sh && notify.sh\n'
    const { exec, state } = makeFakeExec(initial)
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    const res = await a.adopt(42, {
      scheduleExpr: '0 3 * * *',
      command: 'backup.sh && notify.sh',
      schedmgrPath: SCHEDMGR,
      dbPath: DB
    })
    expect(res.ok).toBe(true)
    const written = state.writes.at(-1)!
    expect(written).toContain('# chronos:42')
    // full template: schedule + schedmgr run <id> --db <quoted db> -- '<quoted original>'
    // The db path MUST be shell-quoted: macOS userData is ".../Application Support/..." (has a
    // space), and cron re-parses the line via /bin/sh — an unquoted path splits and schedmgr bails.
    expect(written).toContain(`0 3 * * * '${SCHEDMGR}' run 42 --db '${DB}' -- 'backup.sh && notify.sh'`)
    // re-listing yields the original command back (unquoted), adopted=true
    const j = (await a.list()).find((x) => x.chronosId === 42)!
    expect(j.adopted).toBe(true)
    expect(j.command).toBe('backup.sh && notify.sh')
  })

  it('shell-quotes a spaced schedmgr path so the crontab line stays valid + round-trips (review #10)', async () => {
    const SPACED = '/Applications/Chronos UI.app/Contents/Resources/schedmgr'
    const { exec, state } = makeFakeExec('0 3 * * * backup.sh\n')
    const a = new CrontabAdapter({ exec, schedmgrPath: SPACED, dbPath: DB })
    await a.list()
    const res = await a.adopt(7, { scheduleExpr: '0 3 * * *', command: 'backup.sh', schedmgrPath: SPACED, dbPath: DB })
    expect(res.ok).toBe(true)
    // the spaced path is wrapped in single quotes → ONE shell word; without this the line splits at
    // the space and cron's /bin/sh runs the wrong binary.
    expect(state.writes.at(-1)!).toContain(`'${SPACED}' run 7 --db`)
    // the adapter re-detects its own quoted line as adopted (write/detect symmetry)
    const j = (await a.list()).find((x) => x.chronosId === 7)!
    expect(j.adopted).toBe(true)
    expect(j.command).toBe('backup.sh')
  })

  it('still detects a legacy crontab line written with an UNQUOTED schedmgr path (backward compat — review #10)', async () => {
    const initial = `# chronos:9\n0 3 * * * ${SCHEDMGR} run 9 --db ${DB} -- 'legacy.sh'\n`
    const { exec } = makeFakeExec(initial)
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    const j = (await a.list()).find((x) => x.chronosId === 9)!
    expect(j.adopted).toBe(true) // raw (pre-shellQuote) line is still recognized
    expect(j.command).toBe('legacy.sh')
  })

  it('unadopt restores the bare original command line', async () => {
    const initial = `# chronos:42\n0 3 * * * ${SCHEDMGR} run 42 --db ${DB} -- 'backup.sh && notify.sh'\n`
    const { exec, state } = makeFakeExec(initial)
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    const res = await a.unadopt(42, 'backup.sh && notify.sh')
    expect(res.ok).toBe(true)
    const written = state.writes.at(-1)!
    expect(written).not.toContain('# chronos:42')
    expect(written).not.toContain('schedmgr')
    expect(written).toContain('0 3 * * * backup.sh && notify.sh')
  })

  it("shell-quotes a single-quote-containing command safely", async () => {
    const { exec, state } = makeFakeExec("0 3 * * * echo it's done\n")
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    await a.adopt(9, { scheduleExpr: '0 3 * * *', command: "echo it's done", schedmgrPath: SCHEDMGR, dbPath: DB })
    const written = state.writes.at(-1)!
    expect(written).toContain("-- 'echo it'\\''s done'")
    expect((await a.list()).find((x) => x.chronosId === 9)!.command).toBe("echo it's done")
  })

  it('adopt on an already-adopted job fails (no matching unadopted line) and writes nothing more', async () => {
    const { exec, state } = makeFakeExec('0 3 * * * backup.sh\n')
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    const first = await a.adopt(42, { scheduleExpr: '0 3 * * *', command: 'backup.sh', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(first.ok).toBe(true)
    await a.list()
    const second = await a.adopt(42, { scheduleExpr: '0 3 * * *', command: 'backup.sh', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(second.ok).toBe(false)
    expect(second.error).toBe('no matching unadopted line')
    expect(state.writes).toHaveLength(1) // only the first adopt wrote
  })
})

describe('CrontabAdapter CRUD', () => {
  it('createJob appends a managed (marker + line) entry', async () => {
    const { exec, state } = makeFakeExec('PATH=/usr/bin\n')
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    const res = await a.createJob({ chronosId: 5, scheduleExpr: '*/10 * * * *', command: 'tidy.sh' })
    expect(res.ok).toBe(true)
    const written = state.writes.at(-1)!
    expect(written).toContain('PATH=/usr/bin') // env preserved
    expect(written).toContain('# chronos:5')
    expect(written).toContain('*/10 * * * * tidy.sh')
  })

  it('updateJob changes the schedule, enable/disable toggles, delete removes both lines', async () => {
    const initial = '# chronos:5\n*/10 * * * * tidy.sh\n'
    const { exec, state } = makeFakeExec(initial)
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    expect((await a.updateJob(5, { scheduleExpr: '0 0 * * *' })).ok).toBe(true)
    expect(state.writes.at(-1)!).toContain('0 0 * * * tidy.sh')

    await a.list()
    expect((await a.disableJob(5)).ok).toBe(true)
    expect(state.writes.at(-1)!).toContain('#0 0 * * * tidy.sh')

    await a.list()
    expect((await a.enableJob(5)).ok).toBe(true)
    expect(state.writes.at(-1)!).toContain('0 0 * * * tidy.sh')
    expect(state.writes.at(-1)!).not.toContain('#0 0 * * * tidy.sh')

    await a.list()
    expect((await a.deleteJob(5)).ok).toBe(true)
    expect(state.writes.at(-1)!).not.toContain('chronos:5')
    expect(state.writes.at(-1)!).not.toContain('tidy.sh')
  })
})

describe('CrontabAdapter adopted-detection robustness', () => {
  it('createJob with a command containing " -- " is NOT misdetected as adopted (list does not throw)', async () => {
    const { exec } = makeFakeExec('')
    const a = new CrontabAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB })
    await a.list()
    expect(
      (await a.createJob({ chronosId: 8, scheduleExpr: '0 3 * * *', command: 'npm run build -- --watch' })).ok
    ).toBe(true)
    const j = (await a.list()).find((x) => x.chronosId === 8)!
    expect(j.adopted).toBe(false) // not the schedmgr wrapper, despite containing ' -- '
    expect(j.command).toBe('npm run build -- --watch')
  })
})

describe('CrontabAdapter.adoptMany', () => {
  it('wraps every selected unmanaged line in a SINGLE crontab - write', async () => {
    const initial = ['0 3 * * * /usr/bin/backup.sh', '30 4 * * * /usr/bin/clean.sh', ''].join('\n')
    const writes: string[] = []
    const exec: ExecFn = async (_cmd, args, stdin) => {
      if (args[0] === '-l') return { stdout: initial, exitCode: 0 }
      if (args[0] === '-') {
        writes.push(stdin ?? '')
        return { stdout: '', exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    }
    const a = new CrontabAdapter({ exec, schedmgrPath: '/opt/schedmgr', dbPath: '/db/chronos.db' })
    const specs: AdoptionSpec[] = [
      { chronosId: 1, scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' },
      { chronosId: 2, scheduleExpr: '30 4 * * *', command: '/usr/bin/clean.sh' }
    ]
    const r = await a.adoptMany(specs)
    expect(r.ok).toBe(true)
    expect(r.adopted).toEqual([1, 2])
    expect(writes).toHaveLength(1) // ONE write, not two
    expect(writes[0]).toContain('# chronos:1')
    expect(writes[0]).toContain('# chronos:2')
    expect(writes[0]).toContain("'/opt/schedmgr' run 1 --db '/db/chronos.db'")
    expect(writes[0]).toContain("'/opt/schedmgr' run 2 --db '/db/chronos.db'")
  })

  it('fails the whole batch (no write) when any spec has no matching line', async () => {
    const exec: ExecFn = async (_c, args) =>
      args[0] === '-l' ? { stdout: '0 3 * * * /usr/bin/backup.sh\n', exitCode: 0 } : { stdout: '', exitCode: 0 }
    const a = new CrontabAdapter({ exec, schedmgrPath: '/opt/schedmgr', dbPath: '/db/chronos.db' })
    const r = await a.adoptMany([
      { chronosId: 1, scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' },
      { chronosId: 2, scheduleExpr: '9 9 * * *', command: '/nope.sh' }
    ])
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('no_match')
    expect(r.adopted).toEqual([])
  })

  it('rejects (no write) when two specs match the same identical line — no corruption (code review #3)', async () => {
    const initial = ['0 3 * * * /usr/bin/backup.sh', ''].join('\n')
    const writes: string[] = []
    const exec: ExecFn = async (_c, args, stdin) => {
      if (args[0] === '-l') return { stdout: initial, exitCode: 0 }
      if (args[0] === '-') { writes.push(stdin ?? ''); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = new CrontabAdapter({ exec, schedmgrPath: '/opt/schedmgr', dbPath: '/db/chronos.db' })
    const r = await a.adoptMany([
      { chronosId: 1, scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' },
      { chronosId: 2, scheduleExpr: '0 3 * * *', command: '/usr/bin/backup.sh' }
    ])
    expect(r.ok).toBe(false)
    expect(r.adopted).toEqual([])
    expect(writes).toHaveLength(0)
  })
})

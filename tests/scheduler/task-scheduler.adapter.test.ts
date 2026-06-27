// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter } from '../../src/main/scheduler/task-scheduler.adapter'
import type { ExecFn } from '../../src/main/scheduler/types'

const SCHEDMGR = 'C:\\Program Files\\ChronosUI\\schedmgr.exe'
const DB = 'C:\\Users\\John Doe\\AppData\\ChronosUI\\chronos.db'
const FOLDER = '\\ChronosUI\\'

// fakePwsh routes by matching key cmdlets in the piped script. It NEVER spawns
// PowerShell. `respond` lets a test stub the next list/read JSON; `scripts`
// records every script the adapter ran (so mutations can be asserted).
function makeFakePwsh(opts: { listJson?: string; readJson?: (script: string) => string; xml?: (script: string) => string } = {}) {
  const scripts: string[] = []
  const exec: ExecFn = async (cmd, _args, stdin) => {
    const script = stdin ?? ''
    scripts.push(script)
    if (/Get-ScheduledTask\b/.test(script) && /ConvertTo-Json/.test(script) && /-or \$_\.TaskPath -notlike/.test(script)) {
      return { stdout: opts.listJson ?? '[]', exitCode: 0 } // list()
    }
    if (/Export-ScheduledTask/.test(script)) {
      return { stdout: opts.xml ? opts.xml(script) : '<Task></Task>', exitCode: 0 } // XML read (drift)
    }
    if (/Get-ScheduledTask\b/.test(script) && /ConvertTo-Json/.test(script)) {
      return { stdout: opts.readJson ? opts.readJson(script) : '', exitCode: 0 } // readOne()
    }
    return { stdout: '', exitCode: 0 } // mutating scripts
  }
  return { exec, scripts }
}

function adapter(exec: ExecFn) {
  return new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
}

describe('TaskSchedulerAdapter.list', () => {
  it('parses managed (adopted + unadopted) and unmanaged tasks; managed schedule from the stashed descriptor', async () => {
    const listJson = JSON.stringify([
      {
        TaskName: 'chronos-42',
        TaskPath: FOLDER,
        Description: 'ChronosUI managed job\nchronos:42\nsched:daily 03:00',
        State: 'Ready',
        Actions: [{ Execute: SCHEDMGR, Arguments: `run 42 --db "${DB}" -- "echo hi && date"` }],
        Triggers: [{ CimClass: 'MSFT_TaskDailyTrigger', StartBoundary: '2026-01-01T03:00:00', DaysOfWeek: null, Repetition: null }],
        Xml: '<Task><Date>2026-01-01</Date></Task>'
      },
      {
        TaskName: 'chronos-7',
        TaskPath: FOLDER,
        Description: 'ChronosUI managed job\nchronos:7\nsched:minutes 5',
        State: 'Disabled',
        Actions: [{ Execute: 'cmd.exe', Arguments: '/c tidy.bat' }],
        Triggers: [{ CimClass: 'MSFT_TaskTimeTrigger', StartBoundary: null, DaysOfWeek: null, Repetition: { Interval: 'PT5M' } }],
        Xml: '<Task></Task>'
      },
      {
        TaskName: 'BackupJob',
        TaskPath: '\\',
        Description: 'A user task',
        State: 'Ready',
        Actions: [{ Execute: 'C:\\backup\\run.exe', Arguments: '--full' }],
        Triggers: [{ CimClass: 'MSFT_TaskWeeklyTrigger', StartBoundary: '2026-01-01T09:00:00', DaysOfWeek: 2, Repetition: null }],
        Xml: '<Task></Task>'
      }
    ])
    const a = adapter(makeFakePwsh({ listJson }).exec)
    const jobs = await a.list()

    const adopted = jobs.find((j) => j.chronosId === 42)!
    expect(adopted.adopted).toBe(true)
    expect(adopted.enabled).toBe(true)
    expect(adopted.scheduleExpr).toBe('daily 03:00') // from stashed descriptor, not CIM
    expect(adopted.scheduleExprFormat).toBe('win-trigger')
    expect(adopted.command).toBe('echo hi && date') // unwrapped from after `--`
    expect(adopted.name).toBe('chronos-42') // #8: managed Windows task also carries its real TaskName

    const unadopted = jobs.find((j) => j.chronosId === 7)!
    expect(unadopted.adopted).toBe(false)
    expect(unadopted.enabled).toBe(false)
    expect(unadopted.command).toBe('tidy.bat') // stripped `/c `

    const external = jobs.find((j) => j.chronosId === null)!
    expect(external.adopted).toBe(false)
    expect(external.canAdopt).toBe(true) // single exec action
    expect(external.scheduleExpr).toBe('weekly MON 09:00') // best-effort CIM read-back
    expect(external.command).toBe('C:\\backup\\run.exe --full')
    expect(external.name).toBe('BackupJob') // #8: unmanaged Windows task carries its real Task Scheduler name
  })

  it('tolerates a single-task bare object (ConvertTo-Json array collapse)', async () => {
    const single = JSON.stringify({
      TaskName: 'chronos-1',
      TaskPath: FOLDER,
      Description: 'ChronosUI managed job\nchronos:1\nsched:onlogon',
      State: 'Ready',
      Actions: [{ Execute: 'cmd.exe', Arguments: '/c hi.bat' }],
      Triggers: [{ CimClass: 'MSFT_TaskLogonTrigger', StartBoundary: null, DaysOfWeek: null, Repetition: null }],
      Xml: '<Task></Task>'
    })
    const a = adapter(makeFakePwsh({ listJson: single }).exec)
    const jobs = await a.list()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].chronosId).toBe(1)
  })

  it('every list script sets $ErrorActionPreference = Stop and forces an array', async () => {
    const { exec, scripts } = makeFakePwsh({ listJson: '[]' })
    await adapter(exec).list()
    expect(scripts[0]).toContain("$ErrorActionPreference = 'Stop'")
    expect(scripts[0]).toContain('@($out)')
    expect(scripts[0]).toContain('-Depth 8')
  })
})

describe('TaskSchedulerAdapter drift + enable/disable', () => {
  // Helper: a one-managed-task list whose Xml the test can vary across reads.
  function oneManagedList(xmlInList: string) {
    return JSON.stringify([
      {
        TaskName: 'chronos-42', TaskPath: FOLDER,
        Description: 'ChronosUI managed job\nchronos:42\nsched:daily 03:00',
        State: 'Ready',
        Actions: [{ Execute: 'cmd.exe', Arguments: '/c backup.bat' }],
        Triggers: [{ CimClass: 'MSFT_TaskDailyTrigger', StartBoundary: '2026-01-01T03:00:00', DaysOfWeek: null, Repetition: null }],
        Xml: xmlInList
      }
    ])
  }

  it('normalizeTaskXml ignores volatile <Date> so a Date-only change is NOT drift', async () => {
    let xml = '<Task><Date>2026-01-01</Date><Actions>x</Actions></Task>'
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/ConvertTo-Json/.test(s) && /-or \$_\.TaskPath -notlike/.test(s)) return { stdout: oneManagedList(xml), exitCode: 0 }
      if (/Export-ScheduledTask/.test(s)) return { stdout: xml, exitCode: 0 }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    await a.list() // snapshot
    xml = '<Task><Date>2099-12-31</Date><Actions>x</Actions></Task>' // only the Date moved
    expect((await a.detectDrift()).drifted).toBe(false)
    xml = '<Task><Date>2099-12-31</Date><Actions>CHANGED</Actions></Task>' // real edit
    expect((await a.detectDrift()).drifted).toBe(true)
  })

  it('a mutation refuses with reason=drift if the task XML changed since list()', async () => {
    let xml = '<Task><Actions>orig</Actions></Task>'
    const mutating: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/ConvertTo-Json/.test(s) && /-or \$_\.TaskPath -notlike/.test(s)) return { stdout: oneManagedList(xml), exitCode: 0 }
      if (/Export-ScheduledTask/.test(s)) return { stdout: xml, exitCode: 0 }
      if (/Disable-ScheduledTask/.test(s)) { mutating.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    await a.list()
    xml = '<Task><Actions>EDITED EXTERNALLY</Actions></Task>'
    const res = await a.disableJob(42)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('drift')
    expect(mutating).toHaveLength(0) // nothing was disabled
  })

  it('disableJob runs Disable-ScheduledTask when no drift', async () => {
    const xml = '<Task><Actions>orig</Actions></Task>'
    const mutating: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/ConvertTo-Json/.test(s) && /-or \$_\.TaskPath -notlike/.test(s)) return { stdout: oneManagedList(xml), exitCode: 0 }
      if (/Export-ScheduledTask/.test(s)) return { stdout: xml, exitCode: 0 }
      if (/Disable-ScheduledTask/.test(s)) { mutating.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    await a.list()
    const res = await a.disableJob(42)
    expect(res.ok).toBe(true)
    expect(mutating[0]).toContain("Disable-ScheduledTask -TaskName 'chronos-42'")
    expect(mutating[0]).toContain(`-TaskPath '${FOLDER}'`)
  })

  it('enableJob runs Enable-ScheduledTask when no drift', async () => {
    const xml = '<Task><Actions>orig</Actions></Task>'
    const mutating: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/ConvertTo-Json/.test(s) && /-or \$_\.TaskPath -notlike/.test(s)) return { stdout: oneManagedList(xml), exitCode: 0 }
      if (/Export-ScheduledTask/.test(s)) return { stdout: xml, exitCode: 0 }
      if (/Enable-ScheduledTask/.test(s)) { mutating.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    await a.list()
    const res = await a.enableJob(42)
    expect(res.ok).toBe(true)
    expect(mutating[0]).toContain("Enable-ScheduledTask -TaskName 'chronos-42'")
    expect(mutating[0]).toContain(`-TaskPath '${FOLDER}'`)
  })
})

describe('TaskSchedulerAdapter adopt/unadopt', () => {
  // A managed task that readOne() will report; captures Set-ScheduledTask scripts.
  function fakeFor(opts: { adopted: boolean; runLevel?: string }) {
    const setScripts: string[] = []
    const readJson = JSON.stringify({
      Execute: opts.adopted ? SCHEDMGR : 'cmd.exe',
      Arguments: opts.adopted ? `run 42 --db "${DB}" -- "backup.bat && notify.bat"` : '/c backup.bat && notify.bat',
      Description: 'ChronosUI managed job\nchronos:42\nsched:daily 03:00',
      RunLevel: opts.runLevel ?? 'Limited'
    })
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/Export-ScheduledTask/.test(s)) return { stdout: '<Task><Actions>x</Actions></Task>', exitCode: 0 }
      if (/Get-ScheduledTask\b/.test(s) && /ConvertTo-Json/.test(s) && !/-or \$_\.TaskPath -notlike/.test(s)) {
        return { stdout: readJson, exitCode: 0 } // readOne()
      }
      if (/Set-ScheduledTask/.test(s) || /Principal\.RunLevel/.test(s)) {
        setScripts.push(s)
        if (/Principal\.RunLevel -eq 'Highest'/.test(s) && opts.runLevel === 'Highest') return { stdout: 'refusing', exitCode: 1 }
        return { stdout: '', exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    }
    return { exec, setScripts }
  }

  it('adopt writes schedmgr.exe action with the EXACT quoting chain (winQuote fields + psQuote whole)', async () => {
    const { exec, setScripts } = fakeFor({ adopted: false })
    const a = adapter(exec)
    const res = await a.adopt(42, { scheduleExpr: 'daily 03:00', command: 'backup.bat && notify.bat', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(res.ok).toBe(true)
    const set = setScripts.find((s) => /Set-ScheduledTask/.test(s))!
    // Execute is psQuoted; Argument is `run 42 --db <winQuote(DB)> -- <winQuote(cmd)>` then psQuoted.
    expect(set).toContain(`New-ScheduledTaskAction -Execute '${SCHEDMGR}'`)
    // the inner winQuoteArg wraps DB and the command each as one argv token:
    expect(set).toContain(`run 42 --db "${DB}" -- "backup.bat && notify.bat"`)
  })

  it('refuses to adopt an elevated (HighestAvailable) task', async () => {
    const { exec } = fakeFor({ adopted: false, runLevel: 'Highest' })
    const a = adapter(exec)
    const res = await a.adopt(42, { scheduleExpr: 'daily 03:00', command: 'backup.bat', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/elevated|Highest/i)
  })

  it('adopt then list round-trips the original command back (unwrapped)', async () => {
    // list() reports the adopted form; command must come back unwrapped.
    const listJson = JSON.stringify([
      {
        TaskName: 'chronos-42', TaskPath: FOLDER,
        Description: 'ChronosUI managed job\nchronos:42\nsched:daily 03:00',
        State: 'Ready',
        Actions: [{ Execute: SCHEDMGR, Arguments: `run 42 --db "${DB}" -- "backup.bat && notify.bat"` }],
        Triggers: [{ CimClass: 'MSFT_TaskDailyTrigger', StartBoundary: '2026-01-01T03:00:00', DaysOfWeek: null, Repetition: null }],
        Xml: '<Task></Task>'
      }
    ])
    const a = adapter(makeFakePwsh({ listJson }).exec)
    const j = (await a.list()).find((x) => x.chronosId === 42)!
    expect(j.adopted).toBe(true)
    expect(j.command).toBe('backup.bat && notify.bat')
  })

  it('unadopt restores the bare cmd.exe /c action', async () => {
    const { exec, setScripts } = fakeFor({ adopted: true })
    const a = adapter(exec)
    const res = await a.unadopt(42, 'backup.bat && notify.bat')
    expect(res.ok).toBe(true)
    const set = setScripts.find((s) => /Set-ScheduledTask/.test(s))!
    expect(set).toContain("New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c backup.bat && notify.bat'")
    expect(set).not.toContain('schedmgr')
  })

  it('adoptMany adopts sequentially and reports the ids that succeeded', async () => {
    const { exec } = fakeFor({ adopted: false })
    const a = adapter(exec)
    const r = await a.adoptMany([{ chronosId: 42, scheduleExpr: 'daily 03:00', command: 'backup.bat && notify.bat' }])
    expect(r.ok).toBe(true)
    expect(r.adopted).toEqual([42])
  })

  it('adoptMany stops at the first failure and reports the prefix that succeeded', async () => {
    const { exec } = fakeFor({ adopted: false, runLevel: 'Highest' }) // elevated → adopt refuses
    const a = adapter(exec)
    const r = await a.adoptMany([{ chronosId: 42, scheduleExpr: 'daily 03:00', command: 'backup.bat' }])
    expect(r.ok).toBe(false)
    expect(r.adopted).toEqual([])
  })
})

describe('TaskSchedulerAdapter CRUD', () => {
  it('createJob registers a managed (cmd /c, Limited, IgnoreNew) task with a stashed descriptor', async () => {
    const scripts: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => { scripts.push(stdin ?? ''); return { stdout: '<Task></Task>', exitCode: 0 } }
    const a = adapter(exec)
    const res = await a.createJob({ chronosId: 5, scheduleExpr: 'daily 03:00', command: 'tidy.bat' })
    expect(res.ok).toBe(true)
    const reg = scripts.find((s) => /Register-ScheduledTask/.test(s))!
    expect(reg).toContain("New-ScheduledTaskTrigger -Daily -At '03:00'")
    expect(reg).toContain("New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c tidy.bat'")
    expect(reg).toContain('-MultipleInstances IgnoreNew') // no-overlap (spec §8)
    // RunLevel Limited (no elevation, architect D7) goes on a Principal — Register's
    // -InputObject is a different parameter set than -User/-RunLevel, so combining
    // them throws AmbiguousParameterSet on PS 5.1 (found by the Plan 4b Windows test).
    expect(reg).toContain('New-ScheduledTaskPrincipal -UserId')
    expect(reg).toContain('-RunLevel Limited')
    expect(reg).toContain('-Principal $p')
    expect(reg).toContain('sched:daily 03:00') // descriptor stashed in Description
    expect(reg).toContain("-TaskName 'chronos-5'")
    // the Register-ScheduledTask CALL itself must use ONLY -InputObject (no -User/-RunLevel)
    const registerLine = reg.split('\n').find((l) => l.includes('Register-ScheduledTask'))!
    expect(registerLine).toContain('-InputObject $task')
    expect(registerLine).not.toContain('-RunLevel')
    expect(registerLine).not.toContain('-User ')
  })

  it('createJob rejects a malformed schedule (never silently coerces)', async () => {
    const a = adapter(async () => ({ stdout: '', exitCode: 0 }))
    const res = await a.createJob({ chronosId: 6, scheduleExpr: 'daily 99:99', command: 'x.bat' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/bad time/i)
  })

  it('updateJob changes the schedule on an unadopted job', async () => {
    // readOne reports an UNadopted job; updateJob(schedule) should run Set-ScheduledTask.
    const setScripts: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/Export-ScheduledTask/.test(s)) return { stdout: '<Task></Task>', exitCode: 0 }
      if (/Get-ScheduledTask\b/.test(s) && /ConvertTo-Json/.test(s) && !/-or \$_\.TaskPath -notlike/.test(s)) {
        return { stdout: JSON.stringify({ Execute: 'cmd.exe', Arguments: '/c tidy.bat', Description: 'ChronosUI managed job\nchronos:5\nsched:daily 03:00' }), exitCode: 0 }
      }
      if (/Set-ScheduledTask/.test(s)) { setScripts.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    const res = await a.updateJob(5, { scheduleExpr: 'weekly MON 09:00' })
    expect(res.ok).toBe(true)
    expect(setScripts[0]).toContain("New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '09:00'")
    expect(setScripts[0]).toContain('sched:weekly MON 09:00') // descriptor restashed
  })

  it('updateJob refuses to change an adopted job command', async () => {
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/Export-ScheduledTask/.test(s)) return { stdout: '<Task></Task>', exitCode: 0 }
      if (/Get-ScheduledTask\b/.test(s) && /ConvertTo-Json/.test(s) && !/-or \$_\.TaskPath -notlike/.test(s)) {
        return { stdout: JSON.stringify({ Execute: SCHEDMGR, Arguments: `run 5 --db "${DB}" -- "tidy.bat"`, Description: 'ChronosUI managed job\nchronos:5\nsched:daily 03:00' }), exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    const res = await a.updateJob(5, { command: 'evil.bat' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/adopted/i)
  })

  it('updateJob rejects a malformed scheduleExpr (never silently coerces)', async () => {
    // readOne must report an unadopted job so the adopted-command guard is bypassed.
    const setScripts: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/Export-ScheduledTask/.test(s)) return { stdout: '<Task></Task>', exitCode: 0 }
      if (/Get-ScheduledTask\b/.test(s) && /ConvertTo-Json/.test(s) && !/-or \$_\.TaskPath -notlike/.test(s)) {
        return { stdout: JSON.stringify({ Execute: 'cmd.exe', Arguments: '/c tidy.bat', Description: 'ChronosUI managed job\nchronos:5\nsched:daily 03:00' }), exitCode: 0 }
      }
      if (/Set-ScheduledTask/.test(s)) { setScripts.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    const res = await a.updateJob(5, { scheduleExpr: 'daily 99:99' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/bad time/i)
    expect(setScripts).toHaveLength(0) // Set-ScheduledTask must NOT be called
  })

  it('deleteJob refuses with reason=drift if the task XML changed since list()', async () => {
    let xml = '<Task><Actions>orig</Actions></Task>'
    const unregScripts: string[] = []
    // Build a one-managed-task list JSON inline (mirrors oneManagedList from the drift suite).
    const listFor = (x: string) => JSON.stringify([{
      TaskName: 'chronos-42', TaskPath: FOLDER,
      Description: 'ChronosUI managed job\nchronos:42\nsched:daily 03:00',
      State: 'Ready',
      Actions: [{ Execute: 'cmd.exe', Arguments: '/c backup.bat' }],
      Triggers: [{ CimClass: 'MSFT_TaskDailyTrigger', StartBoundary: '2026-01-01T03:00:00', DaysOfWeek: null, Repetition: null }],
      Xml: x
    }])
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/ConvertTo-Json/.test(s) && /-or \$_\.TaskPath -notlike/.test(s)) {
        return { stdout: listFor(xml), exitCode: 0 }
      }
      if (/Export-ScheduledTask/.test(s)) return { stdout: xml, exitCode: 0 }
      if (/Unregister-ScheduledTask/.test(s)) { unregScripts.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec)
    await a.list() // take snapshot
    xml = '<Task><Actions>EDITED EXTERNALLY</Actions></Task>' // external edit
    const res = await a.deleteJob(42)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('drift')
    expect(unregScripts).toHaveLength(0) // Unregister-ScheduledTask must NOT be called
  })

  it('guard() returns null for un-snapshotted ids so the mutation proceeds', async () => {
    // A fresh adapter has no list() snapshot — guard() should return null and let the
    // mutation run. This pins the "guard returns null for un-snapshotted ids" contract.
    const unregScripts: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => {
      const s = stdin ?? ''
      if (/Export-ScheduledTask/.test(s)) return { stdout: '<Task></Task>', exitCode: 0 }
      if (/Unregister-ScheduledTask/.test(s)) { unregScripts.push(s); return { stdout: '', exitCode: 0 } }
      return { stdout: '', exitCode: 0 }
    }
    const a = adapter(exec) // no list() — snapshots map is empty
    const res = await a.deleteJob(99)
    expect(res.ok).toBe(true)
    expect(unregScripts.length).toBeGreaterThan(0) // Unregister-ScheduledTask WAS called
  })

  it('deleteJob unregisters the task', async () => {
    const scripts: string[] = []
    const exec: ExecFn = async (_c, _a, stdin) => { scripts.push(stdin ?? ''); return { stdout: '', exitCode: 0 } }
    const a = adapter(exec)
    const res = await a.deleteJob(5)
    expect(res.ok).toBe(true)
    expect(scripts.find((s) => /Unregister-ScheduledTask/.test(s))!).toContain("-TaskName 'chronos-5'")
  })
})

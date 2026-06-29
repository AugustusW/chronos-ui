// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter } from '../../src/main/scheduler/task-scheduler.adapter'
import type { ExecFn } from '../../src/main/scheduler/types'

function recExec() {
  const scripts: string[] = []
  const exec = async (_cmd: string, _args: string[], stdin?: string) => {
    scripts.push(stdin ?? '')
    return { stdout: '', exitCode: 0 }
  }
  return { exec, scripts }
}
const opts = (exec: ExecFn) => ({ exec, schedmgrPath: 'C:\\app\\schedmgr.exe', dbPath: 'C:\\db\\chronos.db' })

describe('task-scheduler flush entry', () => {
  it('installFlushEntry registers a repetition task running notify-flush', async () => {
    const r = recExec()
    const a = new TaskSchedulerAdapter(opts(r.exec))
    const res = await a.installFlushEntry(5)
    expect(res.ok).toBe(true)
    const joined = r.scripts.join('\n')
    expect(joined).toContain('notify-flush')
    expect(joined).toMatch(/New-TimeSpan -Minutes 5/)
    expect(joined).toContain('chronos-notify-flush')
  })

  it('removeFlushEntry unregisters the task', async () => {
    const r = recExec()
    const a = new TaskSchedulerAdapter(opts(r.exec))
    const res = await a.removeFlushEntry()
    expect(res.ok).toBe(true)
    expect(r.scripts.join('\n')).toMatch(/Unregister-ScheduledTask.*chronos-notify-flush/s)
  })

  it('installFlushEntry rejects windowMin < 1', async () => {
    const r = recExec()
    const a = new TaskSchedulerAdapter(opts(r.exec))
    const res = await a.installFlushEntry(0)
    expect(res.ok).toBe(false)
    expect(r.scripts).toHaveLength(0) // no PS script fired
  })
})

describe('task-scheduler list() excludes flush task', () => {
  const SCHEDMGR = 'C:\\app\\schedmgr.exe'
  const DB = 'C:\\db\\chronos.db'
  const FOLDER = '\\ChronosUI\\'

  function makeListExec(listJson: string) {
    const exec = async (_cmd: string, _args: string[], stdin?: string) => {
      const script = stdin ?? ''
      // list() build script: has Get-ScheduledTask + ConvertTo-Json + -notlike
      if (/ConvertTo-Json/.test(script) && /-notlike/.test(script)) {
        return { stdout: listJson, exitCode: 0 }
      }
      // Export-ScheduledTask (drift snapshot)
      if (/Export-ScheduledTask/.test(script)) {
        return { stdout: '<Task></Task>', exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    }
    return exec
  }

  it('filters out the flush task from list() results', async () => {
    const listJson = JSON.stringify([
      {
        TaskName: 'chronos-42',
        TaskPath: FOLDER,
        Description: 'ChronosUI managed job\nchronos:42\nsched:daily 03:00',
        State: 'Ready',
        Actions: [{ Execute: SCHEDMGR, Arguments: `run 42 --db "${DB}" -- "echo hi"` }],
        Triggers: [{ CimClass: 'MSFT_TaskDailyTrigger', StartBoundary: '2026-01-01T03:00:00', DaysOfWeek: null, Repetition: null }],
        Xml: '<Task></Task>'
      },
      {
        // This is the flush task — should be excluded
        TaskName: 'chronos-notify-flush',
        TaskPath: FOLDER,
        Description: 'ChronosUI notify-flush',
        State: 'Ready',
        Actions: [{ Execute: SCHEDMGR, Arguments: `notify-flush --db "${DB}"` }],
        Triggers: [{ CimClass: 'MSFT_TaskTimeTrigger', StartBoundary: null, DaysOfWeek: null, Repetition: { Interval: 'PT5M' } }],
        Xml: '<Task></Task>'
      }
    ])

    const exec = makeListExec(listJson)
    const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
    const jobs = await a.list()

    expect(jobs).toHaveLength(1)
    expect(jobs[0].chronosId).toBe(42)
    // Flush task must not appear
    expect(jobs.find((j) => j.name === 'chronos-notify-flush')).toBeUndefined()
  })
})

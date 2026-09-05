// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter, MARKER_SCAN_TAG } from '../../src/main/scheduler/task-scheduler.adapter'
import { parseDescription } from '../../src/main/scheduler/task-marker'
import type { ExecFn } from '../../src/main/scheduler/types'

const SCHEDMGR = 'C:\\Program Files\\ChronosUI\\schedmgr.exe'
const DB = 'C:\\Users\\John Doe\\AppData\\ChronosUI\\chronos.db'
const FOLDER = '\\ChronosUI\\'

function decodeScript(args: readonly string[]): string {
  const i = args.indexOf('-EncodedCommand')
  return i < 0 ? '' : Buffer.from(args[i + 1], 'base64').toString('utf16le')
}

/** An ordinary Windows task nobody has touched: its own name, its own folder, no marker. */
const external = {
  TaskName: 'Nightly Backup',
  TaskPath: '\\Custom\\',
  Execute: 'C:\\Backup\\backup.exe',
  Arguments: '-full',
  Description: 'Runs the nightly backup'
}

function harness(opts: { elevated?: boolean; managed?: { id: number; name: string; path: string } } = {}) {
  const scripts: string[] = []
  const exec: ExecFn = async (_cmd, args) => {
    const s = decodeScript(args)
    scripts.push(s)
    if (s.includes(MARKER_SCAN_TAG)) {
      const m = opts.managed
      return {
        stdout: JSON.stringify(
          m ? [{ TaskName: m.name, TaskPath: m.path, Description: `ChronosUI managed job\nchronos:${m.id}\nsched:daily 03:00` }] : []
        ),
        exitCode: 0
      }
    }
    if (/RunLevel -eq 'Highest'/.test(s)) return { stdout: opts.elevated ? 'elevated' : 'ok', exitCode: opts.elevated ? 1 : 0 }
    if (/ConvertTo-Json/.test(s) && /-TaskName/.test(s)) {
      return { stdout: JSON.stringify({ Execute: external.Execute, Arguments: external.Arguments, Description: external.Description }), exitCode: 0 }
    }
    return { stdout: '', exitCode: 0 }
  }
  const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
  return { a, scripts }
}

describe('adopt marks the task where it already is', () => {
  it('uses the task’s own name and folder, and creates nothing of its own', async () => {
    const h = harness()
    const r = await h.a.adopt(7, {
      scheduleExpr: 'daily 03:00',
      command: 'C:\\Backup\\backup.exe -full',
      schedmgrPath: SCHEDMGR,
      dbPath: DB,
      native: { name: external.TaskName, path: external.TaskPath }
    })
    expect(r.ok).toBe(true)

    const all = h.scripts.join('\n')
    expect(all).toContain("-TaskName 'Nightly Backup'")
    expect(all).toContain("-TaskPath '\\Custom\\'")
    // The negative controls. These are what tell adopting in place apart from moving the task
    // into ChronosUI's folder under a derived name — an implementation that did that would also
    // report success, so "r.ok === true" proves nothing on its own.
    expect(all).not.toContain("'chronos-7'")
    expect(all).not.toContain('Register-ScheduledTask')
    expect(all).not.toContain('Unregister-ScheduledTask')
  })

  it('records the action it replaced, so un-adopt has something to restore', async () => {
    const h = harness()
    await h.a.adopt(7, {
      scheduleExpr: 'daily 03:00',
      command: 'C:\\Backup\\backup.exe -full',
      schedmgrPath: SCHEDMGR,
      dbPath: DB,
      native: { name: external.TaskName, path: external.TaskPath }
    })
    const setScript = h.scripts.find((s) => /Set-ScheduledTask/.test(s))!
    const desc = /\$t\.Description = '([^']*)'/.exec(setScript.replace(/''/g, "'"))?.[1]
    expect(desc).toBeTruthy()
    const marker = parseDescription(desc!.replace(/\\n/g, '\n'))
    expect(marker?.chronosId).toBe(7)
    expect(marker?.original).toEqual({ execute: 'C:\\Backup\\backup.exe', args: '-full' })
  })

  it('prefers the cache over the caller for a job it already manages', async () => {
    // backend-switch's rebakeDescriptors and the compensating re-adopt in jobs.service call
    // adopt() for jobs that are already managed and pass no native at all. Requiring one would
    // break them; falling back to a derived name would keep the old bug for exactly the
    // database-switch path, which touches every adopted job at once.
    const h = harness({ managed: { id: 7, name: 'Known', path: '\\K\\' } })
    await h.a.adopt(7, { scheduleExpr: 'daily 03:00', command: 'x', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(h.scripts.join('\n')).toContain("-TaskName 'Known'")
  })

  it('still refuses an elevated task, now that it is found by native identity', async () => {
    // The D4 guard's existing test dies at the location lookup before reaching the elevated check once the
    // adapter stops deriving names. A red test that fails early is not evidence the guard works,
    // and fixing that red does not re-verify it — so the guard gets its own test on the new path.
    const h = harness({ elevated: true })
    const r = await h.a.adopt(7, {
      scheduleExpr: 'daily 03:00',
      command: 'x',
      schedmgrPath: SCHEDMGR,
      dbPath: DB,
      native: { name: external.TaskName, path: external.TaskPath }
    })
    expect(r.ok).toBe(false)
    expect('error' in r && r.error).toMatch(/elevated/i)
  })

  it('refuses when neither the cache nor the caller knows which task', async () => {
    const h = harness()
    const r = await h.a.adopt(7, { scheduleExpr: 'daily 03:00', command: 'x', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(r.ok).toBe(false)
    expect('error' in r && r.error).toMatch(/which scheduled task to adopt/i)
  })
})

describe('un-adopt puts back the action it found', () => {
  function unadoptHarness(description: string) {
    const scripts: string[] = []
    const exec: ExecFn = async (_cmd, args) => {
      const s = decodeScript(args)
      scripts.push(s)
      if (s.includes(MARKER_SCAN_TAG)) {
        return {
          stdout: JSON.stringify([{ TaskName: 'Nightly Backup', TaskPath: '\\Custom\\', Description: description }]),
          exitCode: 0
        }
      }
      if (/ConvertTo-Json/.test(s) && /-TaskName/.test(s)) {
        return {
          stdout: JSON.stringify({
            Execute: SCHEDMGR,
            Arguments: `run 7 --db "${DB}" -- "C:\\Backup\\backup.exe -full"`,
            Description: description
          }),
          exitCode: 0
        }
      }
      return { stdout: '', exitCode: 0 }
    }
    const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
    return { a, scripts }
  }

  it('restores Execute and Arguments as two fields, not one cmd /c string', async () => {
    const desc = 'ChronosUI managed job\nchronos:7\nsched:daily 03:00\n' +
      `exec:${Buffer.from('C:\\Backup\\backup.exe', 'utf8').toString('base64')}\n` +
      `args:${Buffer.from('-full', 'utf8').toString('base64')}`
    const h = unadoptHarness(desc)
    const r = await h.a.unadopt(7, 'C:\\Backup\\backup.exe -full')
    expect(r.ok).toBe(true)

    const set = h.scripts.find((s) => /Set-ScheduledTask/.test(s))!
    expect(set).toContain("-Execute 'C:\\Backup\\backup.exe'")
    expect(set).toContain("-Argument '-full'")
    expect(set).not.toContain('cmd.exe')
  })

  it('falls back to cmd /c when the marker predates this change', async () => {
    // A task adopted by an earlier build recorded no action. Behaving as before is right;
    // pretending we restored something never recorded is not.
    const h = unadoptHarness('ChronosUI managed job\nchronos:7\nsched:daily 03:00')
    const r = await h.a.unadopt(7, 'C:\\Backup\\backup.exe -full')
    expect(r.ok).toBe(true)

    const set = h.scripts.find((s) => /Set-ScheduledTask/.test(s))!
    expect(set).toContain('cmd.exe')
    expect(set).toContain('/c C:\\Backup\\backup.exe -full')
  })
})

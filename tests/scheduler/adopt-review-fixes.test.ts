// SPDX-License-Identifier: Apache-2.0
//
// The five defects pre-pr-review found on feature/win-adopt-in-place. Each test is written so it
// fails against the code as reviewed: the point is not that adopt succeeds, it is that these
// specific ways of succeeding wrongly are closed.
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter, MARKER_SCAN_TAG } from '../../src/main/scheduler/task-scheduler.adapter'
import { buildDescription } from '../../src/main/scheduler/task-marker'
import type { ExecFn } from '../../src/main/scheduler/types'

const SCHEDMGR = 'C:\\Program Files\\ChronosUI\\schedmgr.exe'
const DB = 'C:\\Users\\John Doe\\AppData\\ChronosUI\\chronos.db'
const FOLDER = '\\ChronosUI\\'

function decodeScript(args: readonly string[]): string {
  const i = args.indexOf('-EncodedCommand')
  return i < 0 ? '' : Buffer.from(args[i + 1], 'base64').toString('utf16le')
}

type Task = {
  TaskName: string
  TaskPath: string
  Execute: string
  Arguments: string
  Description: string
}

/**
 * A fake Task Scheduler that answers each query differently, so a test cannot pass by having one
 * canned payload satisfy two unrelated questions. Export returns a per-task XML string, which is
 * what the drift hash is computed from.
 */
function machine(input: Task[], opts: { onSet?: (s: string) => void } = {}) {
  // Copy, so a test that mutates the machine's state cannot also rewrite the fixture it asserts
  // against. (It could, and did: the expected value moved with the actual one and the assertion
  // compared the change to itself.)
  const tasks = input.map((t) => ({ ...t }))
  const scripts: string[] = []
  const exec: ExecFn = async (_cmd, args) => {
    const s = decodeScript(args)
    scripts.push(s)
    if (s.includes(MARKER_SCAN_TAG)) {
      return {
        stdout: JSON.stringify(tasks.map((t) => ({ TaskName: t.TaskName, TaskPath: t.TaskPath, Description: t.Description }))),
        exitCode: 0
      }
    }
    // list(): the full enumeration, Xml included. Answered separately from the marker scan on
    // purpose — one payload serving both questions is how a fake starts agreeing with itself.
    if (/Xml = \(\[string\]\(Export-ScheduledTask/.test(s)) {
      return {
        stdout: JSON.stringify(
          tasks.map((t) => ({
            TaskName: t.TaskName,
            TaskPath: t.TaskPath,
            State: 'Ready',
            Description: t.Description,
            Actions: [{ Execute: t.Execute, Arguments: t.Arguments }],
            Triggers: [],
            Xml: taskXml(t)
          }))
        ),
        exitCode: 0
      }
    }
    if (/RunLevel -eq 'Highest'/.test(s)) return { stdout: 'ok', exitCode: 0 }
    if (/Export-ScheduledTask/.test(s)) {
      // Export answers for whichever task the script names. Unknown name → the export fails, which
      // is how a moved or deleted task looks.
      const t = tasks.find((x) => s.includes(psLit(x.TaskName)))
      return t ? { stdout: taskXml(t), exitCode: 0 } : { stdout: '', exitCode: 1 }
    }
    if (/ConvertTo-Json/.test(s) && /-TaskName/.test(s)) {
      const t = tasks.find((x) => s.includes(psLit(x.TaskName)))
      if (!t) return { stdout: '', exitCode: 0 }
      return { stdout: JSON.stringify({ Execute: t.Execute, Arguments: t.Arguments, Description: t.Description }), exitCode: 0 }
    }
    if (/Set-ScheduledTask/.test(s)) {
      opts.onSet?.(s)
      return { stdout: '', exitCode: 0 }
    }
    return { stdout: '', exitCode: 0 }
  }
  const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
  return { a, scripts, tasks }
}

/** What Export-ScheduledTask returns. The URI carries the task's name and folder, and
 *  normalizeTaskXml does not strip it — so a rename really does change the drift hash. */
function taskXml(t: Task): string {
  return `<Task><RegistrationInfo><URI>${t.TaskPath}${t.TaskName}</URI></RegistrationInfo><Description>${t.Description}</Description></Task>`
}

/** How a name must appear inside a PowerShell single-quoted literal. */
function psLit(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

const plain: Task = {
  TaskName: 'Nightly Backup',
  TaskPath: '\\Custom\\',
  Execute: 'C:\\Backup\\backup.exe',
  Arguments: '-full',
  Description: 'Runs the nightly backup'
}

const adoptOpts = (t: Task) => ({
  scheduleExpr: 'daily 03:00',
  command: 'C:\\Backup\\backup.exe -full',
  schedmgrPath: SCHEDMGR,
  dbPath: DB,
  native: { name: t.TaskName, path: t.TaskPath }
})

describe('a task name is a value, not script text', () => {
  it('quotes an apostrophe in the name, so the task can be adopted at all', async () => {
    const quoted: Task = { ...plain, TaskName: "Dave's Backup" }
    const m = machine([quoted])
    const r = await m.a.adopt(7, adoptOpts(quoted))
    expect(r.ok).toBe(true)

    const all = m.scripts.join('\n')
    // Doubled, per PowerShell single-quote literal rules.
    expect(all).toContain("'Dave''s Backup'")
    // The unescaped form closes the literal early and turns the rest into stray tokens.
    expect(all).not.toContain("-TaskName 'Dave's Backup'")
  })

  it('quotes an apostrophe in the folder too', async () => {
    const quoted: Task = { ...plain, TaskPath: "\\Dave's Tasks\\" }
    const m = machine([quoted])
    await m.a.adopt(7, adoptOpts(quoted))
    const all = m.scripts.join('\n')
    expect(all).toContain("'\\Dave''s Tasks\\'")
    expect(all).not.toContain("-TaskPath '\\Dave's Tasks\\'")
  })

  it('leaves an ordinary name exactly as it was', async () => {
    const m = machine([plain])
    await m.a.adopt(7, adoptOpts(plain))
    expect(m.scripts.join('\n')).toContain("-TaskName 'Nightly Backup'")
  })
})

describe('the drift baseline recorded after a write is the real one', () => {
  it('does not refuse the next write on a job that was just adopted', async () => {
    const m = machine([plain])
    expect((await m.a.adopt(7, adoptOpts(plain))).ok).toBe(true)
    // Nothing has changed between these two calls. A guard that refuses here is comparing against
    // a baseline it never actually read.
    const r = await m.a.enableJob(7)
    expect(r.reason).not.toBe('drift')
    expect(r.ok).toBe(true)
  })

  it('still refuses when the task really did change underneath', async () => {
    const m = machine([plain])
    await m.a.adopt(7, adoptOpts(plain))
    // Someone edits the task outside ChronosUI.
    m.tasks[0].Description = 'edited by hand'
    const r = await m.a.enableJob(7)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('drift')
  })
})

describe('one ambiguous marker does not block every other job', () => {
  const dup = (id: number, name: string): Task => ({
    ...plain,
    TaskName: name,
    Execute: SCHEDMGR,
    Arguments: `run ${id} --db "${DB}" -- "whatever"`,
    Description: buildDescription(id, 'daily 03:00')
  })

  it('releases the jobs it can and skips only the ambiguous one', async () => {
    const m = machine([
      dup(1, 'Job One'),
      dup(2, 'Two Copy A'),
      { ...dup(2, 'Two Copy B'), TaskPath: '\\Elsewhere\\' },
      dup(3, 'Job Three')
    ])
    const r = await m.a.releaseAll([
      { chronosId: 1, originalCommand: 'a' },
      { chronosId: 2, originalCommand: 'b' },
      { chronosId: 3, originalCommand: 'c' }
    ])
    // Teardown is the user's way out. A duplicate anywhere on the machine must not strand it.
    expect(r.released).toContain(1)
    expect(r.released).toContain(3)
    expect(r.skipped.map((s) => s.chronosId)).toEqual([2])
    expect(r.skipped[0].reason).toBe('ambiguous')
  })

  it('refuses a single write on the ambiguous id rather than picking one', async () => {
    const m = machine([dup(2, 'Two Copy A'), { ...dup(2, 'Two Copy B'), TaskPath: '\\Elsewhere\\' }])
    const r = await m.a.enableJob(2)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/ambiguous/)
  })
})

describe('a rename does not disarm the drift guard', () => {
  it('keeps refusing on the retry, until the list is reopened', async () => {
    const m = machine([{ ...plain, Description: buildDescription(5, 'daily 03:00') }])
    // Seed a real baseline the way the UI does.
    await m.a.list()
    // The user renames the task in Task Scheduler.
    m.tasks[0].TaskName = 'Renamed Backup'

    const first = await m.a.enableJob(5)
    expect(first.ok).toBe(false)
    expect(first.error).toMatch(/renamed/)

    // Clicking the same button again must not go through just because the first attempt healed
    // the cache. Nothing has been re-read yet.
    const second = await m.a.enableJob(5)
    expect(second.ok).toBe(false)
  })
})

describe('adopt does not destroy the description it overwrote', () => {
  it('puts the original description back on un-adopt', async () => {
    const m = machine([plain])
    await m.a.adopt(7, adoptOpts(plain))
    // adopt replaced the task with schedmgr + our marker; readOne reflects that now.
    const stamped = m.scripts.find((s) => /\$t\.Description = /.test(s)) ?? ''
    expect(stamped).toContain('desc:')

    const nowAdopted: Task = {
      ...plain,
      Execute: SCHEDMGR,
      Arguments: `run 7 --db "${DB}" -- "C:\\Backup\\backup.exe -full"`,
      Description: stamped.match(/\$t\.Description = '([\s\S]*?)'\n/)?.[1]?.replace(/''/g, "'") ?? ''
    }

    const sets: string[] = []
    const m2 = machine([nowAdopted], { onSet: (s) => sets.push(s) })
    const r = await m2.a.unadopt(7, 'C:\\Backup\\backup.exe -full')
    expect(r.ok).toBe(true)
    const restore = sets.join('\n')
    expect(restore).toContain(psLit(plain.Description))
    expect(restore).not.toContain('chronos:7')
  })
})

describe('teardown gives the task back the same way un-adopt does', () => {
  it('restores Execute, Arguments and Description verbatim from the marker', async () => {
    const original = { execute: 'C:\\Windows\\System32\\cmd.exe', args: '/c echo adopt-test', description: 'not ours' }
    const adopted: Task = {
      TaskName: 'Adopt Test Task',
      TaskPath: '\\ChronosVerify\\',
      Execute: SCHEDMGR,
      Arguments: `run 1 --db "${DB}" -- "${original.execute} ${original.args}"`,
      Description: buildDescription(1, 'daily 03:00', { execute: original.execute, args: original.args }, original.description)
    }
    const sets: string[] = []
    const m = machine([adopted], { onSet: (s) => sets.push(s) })
    const r = await m.a.releaseAll([{ chronosId: 1, originalCommand: `${original.execute} ${original.args}` }])
    expect(r.released).toEqual([1])

    const script = sets.join('\n')
    // The two fields as the task held them, not the flattened cmd /c rebuild. teardown is the last
    // thing to touch this task; nobody comes back to fix a restore that landed wrong.
    expect(script).toContain(`-Execute ${psLit(original.execute)}`)
    expect(script).toContain(`-Argument ${psLit(original.args)}`)
    expect(script).not.toContain("-Execute 'cmd.exe'")
    // And the description the owner wrote, not an empty string.
    expect(script).toContain(`$t.Description = ${psLit(original.description)}`)
  })

  it('still falls back to cmd /c for a task adopted before the marker carried the fields', async () => {
    const old: Task = {
      TaskName: 'Old Style',
      TaskPath: '\\ChronosVerify\\',
      Execute: SCHEDMGR,
      Arguments: `run 4 --db "${DB}" -- "backup.exe"`,
      Description: 'ChronosUI managed job\nchronos:4\nsched:daily 03:00'
    }
    const sets: string[] = []
    const m = machine([old], { onSet: (s) => sets.push(s) })
    expect((await m.a.releaseAll([{ chronosId: 4, originalCommand: 'backup.exe' }])).released).toEqual([4])
    expect(sets.join('\n')).toContain("-Execute 'cmd.exe' -Argument '/c backup.exe'")
  })
})

describe('a refusal says what is actually wrong', () => {
  it('does not answer "no job N" when the task is the thing that is gone', async () => {
    const m = machine([]) // nothing on the machine carries the marker
    const r = await m.a.enableJob(2)
    expect(r.ok).toBe(false)
    // The criterion the Windows checklist asks for: say the task no longer exists, or that its
    // marker was cleared. "no job 2" says neither, and reads as "ChronosUI has no such job",
    // which is the opposite of what happened.
    expect(r.error).toMatch(/task/i)
    expect(r.error).toMatch(/removed|no longer|cleared/i)
    expect(r.error).toContain('2')
  })

  it('says which of the two unknowns stopped an adopt', async () => {
    const m = machine([])
    const r = await m.a.adopt(7, { scheduleExpr: 'daily 03:00', command: 'x', schedmgrPath: SCHEDMGR, dbPath: DB })
    expect(r.ok).toBe(false)
    // Neither the caller named a task nor does any task carry the marker. Those are different
    // from "the task vanished", and the message should not borrow that wording.
    expect(r.error).toMatch(/which scheduled task/i)
  })
})

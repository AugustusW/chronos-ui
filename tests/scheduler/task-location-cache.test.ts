// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter } from '../../src/main/scheduler/task-scheduler.adapter'
import type { ExecFn } from '../../src/main/scheduler/types'

const SCHEDMGR = 'C:\\Program Files\\ChronosUI\\schedmgr.exe'
const DB = 'C:\\Users\\John Doe\\AppData\\ChronosUI\\chronos.db'
const FOLDER = '\\ChronosUI\\'

function decodeScript(args: readonly string[]): string {
  const i = args.indexOf('-EncodedCommand')
  return i < 0 ? '' : Buffer.from(args[i + 1], 'base64').toString('utf16le')
}

/** A managed task that deliberately does NOT live where its chronosId would imply. */
const elsewhere = {
  TaskName: 'Nightly Backup',
  TaskPath: '\\Custom\\',
  State: 'Ready',
  Description: 'ChronosUI managed job\nchronos:7\nsched:daily 03:00',
  // Double quotes, not single: the adopted Arguments go through winQuoteArg (Windows argv rules),
  // and winUnquoteArg throws on anything else. Copied from the shape the adapter actually emits
  // rather than written from memory.
  Actions: [{ Execute: SCHEDMGR, Arguments: `run 7 --db "${DB}" -- "backup.exe"` }],
  Triggers: [],
  Xml: '<Task><Actions>original</Actions></Task>'
}

function harness(xml = '<Task><Actions>original</Actions></Task>') {
  const scripts: string[] = []
  const exec: ExecFn = async (_cmd, args) => {
    const script = decodeScript(args)
    scripts.push(script)
    if (/Get-ScheduledTask\b/.test(script) && /ConvertTo-Json/.test(script) && /-or \$_\.TaskPath -notlike/.test(script)) {
      return { stdout: JSON.stringify([elsewhere]), exitCode: 0 }
    }
    if (/Export-ScheduledTask/.test(script)) return { stdout: xml, exitCode: 0 }
    return { stdout: '', exitCode: 0 }
  }
  const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
  return { a, scripts }
}

describe('the adapter remembers where a managed task actually is', () => {
  it('list() records the task name and folder, not the ones its id implies', async () => {
    // Every write path derived the name from the chronosId and assumed ChronosUI's own folder.
    // A task worth adopting has neither, which is why adopt could only ever find tasks ChronosUI
    // had created itself.
    const h = harness()
    await h.a.list()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(7)).resolves.toEqual({ name: 'Nightly Backup', path: '\\Custom\\' })
  })

  it('refreshSnapshot updates the hash and KEEPS the location', async () => {
    // The dangerous one. backend-switch's rebakeDescriptors and the compensating re-adopt in
    // jobs.service both call unadopt then adopt on an adapter they hold as
    // Pick<SchedulerAdapter,'unadopt'|'adopt'> — they cannot call list(), so the location they
    // rely on is whatever refreshSnapshot left behind. Drop it there and a single database backend
    // switch takes out every adopted job at once, while a test that seeds the cache through list()
    // still passes.
    const h = harness()
    await h.a.list()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.a as any).refreshSnapshot(7)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(7)).resolves.toEqual({ name: 'Nightly Backup', path: '\\Custom\\' })
  })

  it('knows nothing about an id it has never seen', async () => {
    // Control: proves the two assertions above read something list() put there, rather than a
    // value the adapter derives on demand from the id.
    const h = harness()
    await h.a.list()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(99)).resolves.toBeUndefined()
  })

  it('still detects drift — the hash half of the cache keeps working', async () => {
    // The merge must not cost the existing guard. list() snapshots the XML; a changed export is
    // still drift.
    const h = harness()
    await h.a.list()
    const changed = harness('<Task><Actions>EDITED EXTERNALLY</Actions></Task>')
    await changed.a.list()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = await (h.a as any).taskXmlHash(7)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await (changed.a as any).taskXmlHash(7)
    expect(before).not.toBe(after)
  })
})

/** A managed task, parameterised so a test can put two of them in the same folder tree. */
const managed = (name: string, path: string, id: number) => ({
  TaskName: name,
  TaskPath: path,
  State: 'Ready',
  Description: `ChronosUI managed job\nchronos:${id}\nsched:daily 03:00`,
  Actions: [{ Execute: SCHEDMGR, Arguments: `run ${id} --db "${DB}" -- "backup.exe"` }],
  Triggers: [],
  Xml: '<Task/>'
})

function lookupHarness(tasks: object[]) {
  const scripts: string[] = []
  const exec: ExecFn = async (_cmd, args) => {
    const script = decodeScript(args)
    scripts.push(script)
    if (/Get-ScheduledTask\b/.test(script) && /ConvertTo-Json/.test(script)) {
      return { stdout: JSON.stringify(tasks), exitCode: 0 }
    }
    return { stdout: '', exitCode: 0 }
  }
  const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
  return { a, scripts }
}

describe('finding a managed task by its marker when the cache is cold', () => {
  it('finds one without list() having run first', async () => {
    // rebakeDescriptors and teardown build their specs straight from the database and never call
    // list(). Requiring a warm cache would mean those paths keep the bug this change removes.
    const h = lookupHarness([managed('Backup', '\\Custom\\', 7)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(7)).resolves.toEqual({ name: 'Backup', path: '\\Custom\\' })
  })

  it('does not confuse chronos:5 with chronos:50', async () => {
    // The marker regex in task-marker.ts is anchored (/^chronos:(\d+)$/m) for exactly this reason.
    // A substring match on 'chronos:5' finds chronos:50, and the answer then goes into the cache —
    // after which every write for id 5 lands on someone else's task.
    const h = lookupHarness([managed('Other', '\\', 50)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(5)).resolves.toBeUndefined()
  })

  it('refuses when two tasks carry the same marker', async () => {
    // Export/Import in Task Scheduler duplicates a task along with its Description. Picking the
    // first would send writes to an arbitrary one of the two.
    const h = lookupHarness([managed('A', '\\', 7), managed('B', '\\Other\\', 7)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(7)).rejects.toThrow(/ambiguous/i)
  })

  it('caches every marker the scan saw, not only the id it was asked for', async () => {
    // rebakeDescriptors asks for N ids in a row. One scan per id turns a backend switch into N
    // full enumerations of the machine's scheduled tasks.
    const h = lookupHarness([managed('A', '\\', 7), managed('B', '\\', 8)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (h.a as any).locationOf(7)
    const afterFirst = h.scripts.length
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((h.a as any).locationOf(8)).resolves.toEqual({ name: 'B', path: '\\' })
    expect(h.scripts.length).toBe(afterFirst) // no second scan
  })

  it('scans the same range list() does — not the whole machine', async () => {
    // The NFR argument for this fallback is "one scan costs what list() costs", which only holds
    // while the two ranges match. Comparing the lookup's filter against list()'s own output rather
    // than against a literal means this keeps checking the real thing if either script changes.
    const h = lookupHarness([managed('A', '\\', 7)])
    await h.a.list()
    const listFilter = /Where-Object \{ (.*?) \}/.exec(h.scripts[0])?.[1]
    expect(listFilter).toBeTruthy()

    h.scripts.length = 0
    const cold = lookupHarness([managed('A', '\\', 7)])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (cold.a as any).locationOf(7)
    expect(cold.scripts[0]).toContain(listFilter!)
  })
})

describe('a stale location must not turn into a silent teardown failure', () => {
  it('releaseAll still finds a task that was renamed after list()', async () => {
    // releaseAll deliberately skips guard() — teardown is the user's exit path and must not be
    // blocked by one external edit. The cost is that "not found" is indistinguishable from
    // "already gone", and a stale cached name produces the first while meaning neither: teardown
    // reports success, and the task is left pointing at a schedmgr.exe that is about to be
    // deleted. Every trigger after that fails silently.
    const before = managed('Old', '\\', 7)
    const after = managed('Renamed', '\\', 7)
    let current: object[] = [before]

    const scripts: string[] = []
    // The fake answers "list every task" and "read this one task" differently, because the adapter
    // asks two different questions and a double that conflates them cannot show a stale name being
    // used: readOne would appear to succeed against a task that is no longer there.
    const exec: ExecFn = async (_cmd, args) => {
      const script = decodeScript(args)
      scripts.push(script)
      const one = /-TaskName '([^']+)'/.exec(script)
      if (one && /ConvertTo-Json/.test(script) && !/foreach/.test(script)) {
        const hit = current.find((t) => (t as { TaskName: string }).TaskName === one[1])
        if (!hit) return { stdout: '', exitCode: 0 } // the name we asked for does not exist
        const t = hit as { Actions: { Execute: string; Arguments: string }[]; Description: string }
        return {
          stdout: JSON.stringify({ Execute: t.Actions[0].Execute, Arguments: t.Actions[0].Arguments, Description: t.Description }),
          exitCode: 0
        }
      }
      if (/Get-ScheduledTask\b/.test(script) && /ConvertTo-Json/.test(script)) {
        return { stdout: JSON.stringify(current), exitCode: 0 }
      }
      return { stdout: '', exitCode: 0 }
    }
    const a = new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })

    await a.list() // caches 'Old'
    current = [after] // the user renames it in Task Scheduler

    const r = await a.releaseAll([{ chronosId: 7, originalCommand: 'backup.exe' }])
    expect(r.skipped).toEqual([])
    expect(r.released).toEqual([7])
    expect(scripts.some((s) => s.includes("'Renamed'"))).toBe(true)
  })
})

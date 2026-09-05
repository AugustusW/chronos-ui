// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter, MARKER_SCAN_TAG } from '../../src/main/scheduler/task-scheduler.adapter'
import type { ExecFn } from '../../src/main/scheduler/types'

const SCHEDMGR = 'C:\\s.exe'
const DB = 'C:\\d'
const FOLDER = '\\ChronosUI\\'

function decodeScript(args: readonly string[]): string {
  const i = args.indexOf('-EncodedCommand')
  return i < 0 ? '' : Buffer.from(args[i + 1], 'base64').toString('utf16le')
}

const task = (name: string, path = '\\') => ({
  TaskName: name,
  TaskPath: path,
  State: 'Ready',
  Description: 'ChronosUI managed job\nchronos:7\nsched:daily 03:00',
  Actions: [{ Execute: 'cmd.exe', Arguments: '/c backup.bat' }],
  Triggers: [],
  Xml: '<Task><Actions>original</Actions></Task>'
})

/** `exportFor` decides whether Export-ScheduledTask succeeds, and for which name. */
function harness(opts: { listed: object[]; scanned: object[]; exportFor?: string; exportXml?: string }) {
  const exec: ExecFn = async (_cmd, args) => {
    const s = decodeScript(args)
    if (s.includes(MARKER_SCAN_TAG)) {
      return { stdout: JSON.stringify(opts.scanned.map((t) => {
        const x = t as { TaskName: string; TaskPath: string; Description: string }
        return { TaskName: x.TaskName, TaskPath: x.TaskPath, Description: x.Description }
      })), exitCode: 0 }
    }
    // list()'s script also contains Export-ScheduledTask — it exports each task's XML for the drift
    // snapshot. Checking for that substring first would swallow the list query and answer it with
    // an export failure, which is how a double ends up answering a question it was never asked.
    if (/ConvertTo-Json/.test(s) && /foreach/.test(s)) return { stdout: JSON.stringify(opts.listed), exitCode: 0 }
    if (/Export-ScheduledTask/.test(s)) {
      const name = /-TaskName '([^']+)'/.exec(s)?.[1]
      if (opts.exportFor && name === opts.exportFor) {
        return { stdout: opts.exportXml ?? '<Task><Actions>original</Actions></Task>', exitCode: 0 }
      }
      return { stdout: '', exitCode: 1 } // no such task at that name
    }
    return { stdout: '', exitCode: 0 }
  }
  return new TaskSchedulerAdapter({ exec, schedmgrPath: SCHEDMGR, dbPath: DB, taskFolder: FOLDER })
}

describe('guard says which kind of change it found', () => {
  it('renamed: names where the task went', async () => {
    // Export fails at the cached name and the marker turns up under another one. Saying only
    // "drift" sends the user looking for an edit that never happened.
    const a = harness({ listed: [task('Old')], scanned: [task('Renamed')], exportFor: 'Renamed' })
    await a.list()
    const r = await a.enableJob(7)
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toMatch(/Renamed/)
  })

  it('removed: says the task is gone rather than changed', async () => {
    const a = harness({ listed: [task('Old')], scanned: [] })
    await a.list()
    const r = await a.enableJob(7)
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toMatch(/no longer|not found|gone/i)
    expect(r.error ?? '').not.toMatch(/renamed/i)
  })

  it('edited: keeps the existing drift result', async () => {
    // Export succeeds, the XML differs. Nothing new to say, and reason must stay 'drift' so the
    // callers that branch on it keep working.
    const a = harness({ listed: [task('Old')], scanned: [task('Old')], exportFor: 'Old' })
    await a.list()
    const edited = harness({ listed: [task('Old')], scanned: [task('Old')], exportFor: 'Old', exportXml: '<Task><Actions>EDITED</Actions></Task>' })
    await edited.list()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(edited as any).snapshots.set(7, { ...(edited as any).snapshots.get(7), hash: 'stale-hash' })
    const r = await edited.enableJob(7)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('drift')
  })
})

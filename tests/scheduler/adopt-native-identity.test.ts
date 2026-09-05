// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { TaskSchedulerAdapter } from '../../src/main/scheduler/task-scheduler.adapter'
import type { AdoptOptions, ExecFn } from '../../src/main/scheduler/types'

// A first version of this file asserted that `spec.native?.name === 'Backup'` on an object literal
// the test itself had written. It passed before the field existed, and would have passed if the
// field were never added: `tsconfig.node.json` covers src/ only, so `npm run typecheck` never sees
// tests/ and vitest transpiles without checking types. Nothing about that test could fail.
//
// The type change is worth nothing on its own anyway. What matters is that the identity survives
// the trip, and the trip is where it was being lost: adoptMany rebuilds an AdoptOptions literal
// from the spec, copying scheduleExpr and command only. So this observes the value arriving.
describe('the native identity survives adoptMany → adopt', () => {
  it('adoptMany hands it to adopt(), not just the schedule and command', async () => {
    const exec: ExecFn = async () => ({ stdout: '[]', exitCode: 0 })
    const a = new TaskSchedulerAdapter({
      exec,
      schedmgrPath: 'C:\\s.exe',
      dbPath: 'C:\\d',
      taskFolder: '\\X\\'
    })

    const seen: AdoptOptions[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(a as any).adopt = async (_id: number, opts: AdoptOptions) => {
      seen.push(opts)
      return { ok: true }
    }

    await a.adoptMany([
      { chronosId: 7, scheduleExpr: 'daily 03:00', command: 'x', native: { name: 'Backup', path: '\\' } }
    ])

    expect(seen).toHaveLength(1)
    expect(seen[0].native).toEqual({ name: 'Backup', path: '\\' })
  })

  it('a spec without a native identity still reaches adopt — crontab passes none', async () => {
    // Control: proves the assertion above is reading a value that travelled, not one the adapter
    // invents. If adoptMany fabricated a native, this would see it.
    const exec: ExecFn = async () => ({ stdout: '[]', exitCode: 0 })
    const a = new TaskSchedulerAdapter({ exec, schedmgrPath: 'C:\\s.exe', dbPath: 'C:\\d', taskFolder: '\\X\\' })
    const seen: AdoptOptions[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(a as any).adopt = async (_id: number, opts: AdoptOptions) => { seen.push(opts); return { ok: true } }

    await a.adoptMany([{ chronosId: 8, scheduleExpr: 'daily 04:00', command: 'y' }])
    expect(seen[0].native).toBeUndefined()
  })
})

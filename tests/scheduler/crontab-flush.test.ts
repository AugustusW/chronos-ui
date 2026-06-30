// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { CrontabAdapter, type ExecFn } from '../../src/main/scheduler/crontab.adapter'

function fakeExecWith(initial: string) {
  let table = initial
  const exec = async (cmd: string, args: string[], stdin?: string) => {
    if (cmd === 'crontab' && args[0] === '-l') return { stdout: table, exitCode: 0 }
    if (cmd === 'crontab' && args[0] === '-') { table = stdin ?? ''; return { stdout: '', exitCode: 0 } }
    return { stdout: '', exitCode: 1 }
  }
  return { exec, table: () => table }
}

const opts = (exec: ExecFn) => ({ exec, schedmgrPath: '/opt/schedmgr', dbPath: '/db/chronos.db' })

describe('crontab flush entry', () => {
  it('installFlushEntry writes a */N notify-flush line under the reserved marker', async () => {
    const f = fakeExecWith('')
    const a = new CrontabAdapter(opts(f.exec))
    const r = await a.installFlushEntry(5)
    expect(r.ok).toBe(true)
    expect(f.table()).toContain('# chronos:notify-flush')
    expect(f.table()).toMatch(/\*\/5 \* \* \* \* '\/opt\/schedmgr' notify-flush --db /)
  })

  it('installFlushEntry is idempotent (replaces, no duplicate)', async () => {
    const f = fakeExecWith('')
    const a = new CrontabAdapter(opts(f.exec))
    await a.installFlushEntry(5)
    await a.installFlushEntry(10)
    // marker + cron line = 2 occurrences of "notify-flush"; no duplicates means exactly 2, not 4
    // (brief had .toBe(1) — corrected: marker '# chronos:notify-flush' also contains the substring)
    expect((f.table().match(/notify-flush/g) ?? []).length).toBe(2)
    expect(f.table()).toContain('*/10 * * * *')
  })

  it('removeFlushEntry deletes the line + marker', async () => {
    const f = fakeExecWith('')
    const a = new CrontabAdapter(opts(f.exec))
    await a.installFlushEntry(5)
    const r = await a.removeFlushEntry()
    expect(r.ok).toBe(true)
    expect(f.table()).not.toContain('notify-flush')
    expect(f.table()).not.toContain('# chronos:notify-flush')
  })

  it('list() does NOT surface the flush entry as an adoptable job', async () => {
    const f = fakeExecWith('')
    const a = new CrontabAdapter(opts(f.exec))
    await a.installFlushEntry(5)
    const jobs = await a.list()
    expect(jobs.find((j) => j.command.includes('notify-flush'))).toBeUndefined()
  })
})

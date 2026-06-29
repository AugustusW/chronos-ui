// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { createLaunchdFlush, LAUNCHD_FLUSH_LABEL } from '../../src/main/services/notify-flush-launchd'

const DIR = '/home/u/Library/LaunchAgents'
const PLIST = `${DIR}/${LAUNCHD_FLUSH_LABEL}.plist`

function harness(execImpl?: (cmd: string, args: string[]) => { exitCode: number; stdout: string }) {
  const files: Record<string, string> = {}
  const removed: string[] = []
  const exec = vi.fn(async (cmd: string, args: string[]) =>
    execImpl ? execImpl(cmd, args) : { exitCode: 0, stdout: '' }
  )
  const writeFile = vi.fn((p: string, c: string) => {
    files[p] = c
  })
  const rmFile = vi.fn((p: string) => {
    removed.push(p)
  })
  const sched = createLaunchdFlush({
    schedmgrPath: '/opt/schedmgr',
    dbDescriptor: 'pg:keychain:com.x/pg-dsn',
    launchAgentsDir: DIR,
    uid: 501,
    exec,
    writeFile,
    rmFile
  })
  return { sched, files, removed, exec, writeFile, rmFile }
}

describe('launchd flush scheduler', () => {
  it('install writes a plist with label, ProgramArguments, StartInterval = N*60', async () => {
    const h = harness()
    const r = await h.sched.install(5)
    expect(r.ok).toBe(true)
    const plist = h.files[PLIST]
    expect(plist).toContain(`<string>${LAUNCHD_FLUSH_LABEL}</string>`)
    expect(plist).toContain('<string>/opt/schedmgr</string>')
    expect(plist).toContain('<string>notify-flush</string>')
    expect(plist).toContain('<string>--db</string>')
    expect(plist).toContain('<string>pg:keychain:com.x/pg-dsn</string>')
    expect(plist).toMatch(/<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
  })

  it('install boots out (idempotent) then bootstraps gui/<uid> <plist>', async () => {
    const h = harness()
    await h.sched.install(2)
    const lc = h.exec.mock.calls.filter((c) => c[0] === 'launchctl').map((c) => c[1])
    expect(lc[0]).toEqual(['bootout', `gui/501/${LAUNCHD_FLUSH_LABEL}`])
    expect(lc[1]).toEqual(['bootstrap', 'gui/501', PLIST])
  })

  it('install rejects windowMin < 1 with no exec / no write', async () => {
    const h = harness()
    const r = await h.sched.install(0)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('error')
    expect(h.exec).not.toHaveBeenCalled()
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  it('remove tolerates rmFile throwing (best-effort)', async () => {
    const sched = createLaunchdFlush({
      schedmgrPath: '/opt/schedmgr',
      dbDescriptor: 'x',
      launchAgentsDir: DIR,
      uid: 501,
      exec: async () => ({ exitCode: 0, stdout: '' }),
      writeFile: () => {},
      rmFile: () => {
        throw new Error('EBUSY')
      }
    })
    const r = await sched.remove()
    expect(r.ok).toBe(true)
  })

  it('install returns an error result when bootstrap exits non-zero', async () => {
    const h = harness((_cmd, args) =>
      args[0] === 'bootstrap' ? { exitCode: 5, stdout: 'boom' } : { exitCode: 0, stdout: '' }
    )
    const r = await h.sched.install(3)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('error')
  })

  it('remove boots out and removes the plist (idempotent)', async () => {
    const h = harness()
    const r = await h.sched.remove()
    expect(r.ok).toBe(true)
    const lc = h.exec.mock.calls.filter((c) => c[0] === 'launchctl').map((c) => c[1])
    expect(lc[0]).toEqual(['bootout', `gui/501/${LAUNCHD_FLUSH_LABEL}`])
    expect(h.removed).toContain(PLIST)
  })
})

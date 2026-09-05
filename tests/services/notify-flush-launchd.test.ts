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
    // ProgramArguments now runs the command through /bin/sh -c so the agent can self-clean
    // (teardown spec §3); the schedmgr invocation lives inside that script.
    expect(plist).toContain('<string>/bin/sh</string>')
    expect(plist).toContain('<string>-c</string>')
    expect(plist).toContain('/opt/schedmgr')
    expect(plist).toContain('notify-flush')
    expect(plist).toContain('--db')
    expect(plist).toContain('pg:keychain:com.x/pg-dsn')
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

describe('launchd flush self-clean (teardown spec §3)', () => {
  const MISS = '/home/u/Library/Application Support/ChronosUI/notify-flush-miss'
  const BUNDLE = '/Applications/ChronosUI.app'

  function selfCleanHarness(appBundlePath: string | null) {
    const files: Record<string, string> = {}
    const removed: string[] = []
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '' }))
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
      appBundlePath,
      missCounterPath: MISS,
      exec,
      writeFile,
      rmFile
    })
    return { sched, files, removed, exec }
  }

  it('packaged: the script deletes the counter file and the plist BEFORE bootout', async () => {
    const h = selfCleanHarness(BUNDLE)
    await h.sched.install(5)
    const script = h.files[PLIST]
    const rmIdx = script.indexOf('rm -f')
    const bootoutIdx = script.indexOf('launchctl bootout')
    expect(rmIdx).toBeGreaterThan(-1)
    expect(bootoutIdx).toBeGreaterThan(rmIdx)
    // A3 實測：bootout 會當場終止腳本，所以刪檔必須在它之前，且它之後不能有指令。
    expect(script.slice(rmIdx, bootoutIdx)).toContain('notify-flush-miss')
  })

  it('packaged: bootout is the last command in the script', async () => {
    const h = selfCleanHarness(BUNDLE)
    await h.sched.install(5)
    const script = h.files[PLIST]
    const body = script.slice(script.indexOf('<string>'), script.lastIndexOf('</string>'))
    const after = body.slice(body.indexOf('launchctl bootout'))
    // 只允許 bootout 那一行本身（含結尾換行/空白），不得再有其他指令
    expect(after.replace(/launchctl bootout[^\n]*/, '').trim()).toBe('')
  })

  it('packaged: checks the app BUNDLE directory, not the schedmgr binary', async () => {
    const h = selfCleanHarness(BUNDLE)
    await h.sched.install(5)
    const script = h.files[PLIST]
    // 判 bundle 目錄；判 binary 會在 app 更新期間誤判（spec §3、假設 A4）
    expect(script).toContain(`-d `)
    expect(script).toContain(BUNDLE)
  })

  it('packaged: only self-cleans after three consecutive misses', async () => {
    const h = selfCleanHarness(BUNDLE)
    await h.sched.install(5)
    expect(h.files[PLIST]).toContain('-lt 3')
  })

  it('dev (no bundle path): same /bin/sh -c shape but no self-clean branch', async () => {
    const h = selfCleanHarness(null)
    await h.sched.install(5)
    const script = h.files[PLIST]
    expect(script).toContain('<string>/bin/sh</string>')
    expect(script).not.toContain('launchctl bootout')
    expect(script).not.toContain('notify-flush-miss')
  })

  it('remove() deletes the miss counter file as well as the plist', async () => {
    const h = selfCleanHarness(BUNDLE)
    await h.sched.remove()
    expect(h.removed).toContain(MISS)
    expect(h.removed).toContain(PLIST)
  })
})

describe('refreshIfStale — upgrading an agent installed by an older build', () => {
  const BUNDLE = '/Applications/ChronosUI.app'
  const MISS = '/home/u/Library/Application Support/chronos-ui/notify-flush-miss'

  // Verbatim from a real machine running 0.2.0 (2026-09-05): schedmgr is invoked directly, so there
  // is no /bin/sh wrapper and no self-clean branch. install() is only called when the user saves
  // notification settings, so an upgrader keeps this file forever and never gets the self-clean.
  const LEGACY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_FLUSH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/schedmgr</string>
    <string>notify-flush</string>
    <string>--db</string>
    <string>/home/u/Library/Application Support/chronos-ui/chronos.db</string>
  </array>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`

  function refreshHarness(seed?: string) {
    const files: Record<string, string> = {}
    if (seed !== undefined) files[PLIST] = seed
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '' }))
    const writeFile = vi.fn((p: string, c: string) => {
      files[p] = c
    })
    const sched = createLaunchdFlush({
      schedmgrPath: '/opt/schedmgr',
      dbDescriptor: 'pg:keychain:com.x/pg-dsn',
      launchAgentsDir: DIR,
      uid: 501,
      appBundlePath: BUNDLE,
      missCounterPath: MISS,
      exec,
      writeFile,
      rmFile: vi.fn(),
      readFile: (p: string) => (p in files ? files[p] : null)
    })
    return { sched, files, exec, writeFile }
  }

  it('rewrites a plist written by an older build, so the self-clean actually reaches upgraders', async () => {
    const h = refreshHarness(LEGACY_PLIST)
    const r = await h.sched.refreshIfStale(10)
    expect(r?.ok).toBe(true)
    expect(h.writeFile).toHaveBeenCalledTimes(1)
    // The whole point: the rewritten agent carries the self-clean branch the legacy one lacked.
    expect(h.files[PLIST]).toContain('<string>/bin/sh</string>')
    expect(h.files[PLIST]).toContain('launchctl bootout')
    // …and it is actually reloaded, not just written to disk.
    expect(h.exec).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootstrap']))
  })

  it('leaves an already-current plist alone — no rewrite, no launchctl churn', async () => {
    const h = refreshHarness()
    await h.sched.install(10)
    h.writeFile.mockClear()
    h.exec.mockClear()

    const r = await h.sched.refreshIfStale(10)
    expect(r).toBeNull()
    expect(h.writeFile).not.toHaveBeenCalled()
    // Reloading on every launch would restart the StartInterval countdown, so an app opened and
    // closed more often than the flush window would never flush at all.
    expect(h.exec).not.toHaveBeenCalled()
  })

  it('does NOT create an agent when none is installed', async () => {
    // No plist on disk means either notifications are off or teardown removed it. Writing one here
    // would resurrect the entry teardown just deleted, on the very next launch.
    const h = refreshHarness()
    const r = await h.sched.refreshIfStale(10)
    expect(r).toBeNull()
    expect(h.writeFile).not.toHaveBeenCalled()
    expect(h.exec).not.toHaveBeenCalled()
  })
})

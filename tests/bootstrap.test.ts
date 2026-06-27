// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildMainDeps } from '../src/main/bootstrap'
import type { ExecFn } from '../src/main/scheduler'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// The real project root (this test lives at chronos-ui/tests/), so the :memory: branch finds
// the real src/main/db/migrations folder.
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const fakeApp = {
  getName: () => 'chronos-ui', getVersion: () => '0.1.0', isPackaged: false,
  getPath: () => '/tmp/chronos-test-userdata', getAppPath: () => APP_ROOT
}
const exec: ExecFn = async () => ({ stdout: '', exitCode: 0 })

describe('buildMainDeps', () => {
  it('assembles a complete IpcDeps from an injected app + exec (no real Electron)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(built.deps.meta).toEqual({ name: 'chronos-ui', version: '0.1.0' })
    expect(typeof built.deps.runNow).toBe('function')
    expect(typeof built.deps.listRunsForJob).toBe('function')
    expect(typeof built.deps.service.list).toBe('function')
    expect(built.schedmgrDescriptor).toBe(':memory:') // default config = sqlite → descriptor == dbPath
    await built.handle.close()
  })
  it('exposes the Plan 6 streaming deps (emit + runNowStreaming + cancelBatch + dbPath)', async () => {
    const built = await buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(typeof built.deps.runNowStreaming).toBe('function')
    expect(typeof built.deps.cancelBatch).toBe('function')
    expect(typeof built.emit).toBe('function')
    expect(built.dbPath).toBe(':memory:')
    await built.handle.close()
  })
})

describe('buildMainDeps schedmgr descriptor (postgres backend config)', () => {
  it('computes + bakes the pg:keychain descriptor into the cron line (not the sqlite path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-'))
    writeFileSync(
      join(dir, 'chronos-config.json'),
      JSON.stringify({ backend: 'postgres', pgService: 'com.augustusw.chronos-ui/pg-dsn' })
    )
    let crontabWritten = ''
    // The schedmgr `--db` wrap is produced by adopt/adoptMany (which wrap an existing unmanaged
    // line). Return that unmanaged line on `crontab -l`; capture the wrapped write on `crontab -`.
    const capExec: ExecFn = async (cmd, args, stdin) => {
      if (cmd === 'crontab' && args[0] === '-l') return { stdout: '0 3 * * * /b.sh\n', exitCode: 0 }
      if (cmd === 'crontab' && args[0] === '-' && stdin) crontabWritten = stdin
      return { stdout: '', exitCode: 0 }
    }
    const pgApp = { ...fakeApp, getPath: () => dir }
    // Boot still opens SQLite (Plan 2 keeps the GUI on sqlite; Plan 3 switches GUI boot). Only the
    // schedmgr descriptor reflects the backend config here.
    const built = await buildMainDeps(pgApp, { exec: capExec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(built.schedmgrDescriptor).toBe('pg:keychain:com.augustusw.chronos-ui/pg-dsn')

    // Adopting the unmanaged line bakes the descriptor (the non-secret keychain reference) — NOT the
    // sqlite path, and NOT the DSN — into the schedmgr-wrapped crontab line.
    await built.deps.service.adopt([{ scheduleExpr: '0 3 * * *', command: '/b.sh' }])
    expect(crontabWritten).toContain('--db pg:keychain:com.augustusw.chronos-ui/pg-dsn')
    expect(crontabWritten).not.toContain('chronos.db')

    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('threads the descriptor into the runNow schedmgr argv (a runner path, not just the adapter)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chronos-boot-'))
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 'svc' }))
    let gotArgs: string[] = []
    const spawn = (_c: string, args: string[]): never => {
      gotArgs = args
      const ee = new EventEmitter()
      queueMicrotask(() => ee.emit('exit', 0))
      return ee as never
    }
    const pgApp = { ...fakeApp, getPath: () => dir }
    const built = await buildMainDeps(pgApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:', spawn })
    const created = await built.deps.service.create({ name: 'X', scheduleExpr: '0 3 * * *', command: '/b.sh' })
    const jobId = (created as { job?: { id: number } }).job!.id
    await built.deps.runNow(jobId)
    const i = gotArgs.indexOf('--db')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(gotArgs[i + 1]).toBe('pg:keychain:svc') // runner bakes the descriptor, not the sqlite path
    await built.handle.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

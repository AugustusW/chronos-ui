// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildMainDeps } from '../src/main/bootstrap'
import type { ExecFn } from '../src/main/scheduler'
import { fileURLToPath } from 'node:url'

// The real project root (this test lives at chronos-ui/tests/), so the :memory: branch finds
// the real src/main/db/migrations folder.
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const fakeApp = {
  getName: () => 'chronos-ui', getVersion: () => '0.1.0', isPackaged: false,
  getPath: () => '/tmp/chronos-test-userdata', getAppPath: () => APP_ROOT
}
const exec: ExecFn = async () => ({ stdout: '', exitCode: 0 })

describe('buildMainDeps', () => {
  it('assembles a complete IpcDeps from an injected app + exec (no real Electron)', () => {
    const built = buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(built.deps.meta).toEqual({ name: 'chronos-ui', version: '0.1.0' })
    expect(typeof built.deps.runNow).toBe('function')
    expect(typeof built.deps.listRunsForJob).toBe('function')
    expect(typeof built.deps.service.list).toBe('function')
    built.handle.close()
  })
  it('exposes the Plan 6 streaming deps (emit + runNowStreaming + cancelBatch + dbPath)', () => {
    const built = buildMainDeps(fakeApp, { exec, platform: 'darwin', appRoot: APP_ROOT, resourcesPath: '/x', dbPath: ':memory:' })
    expect(typeof built.deps.runNowStreaming).toBe('function')
    expect(typeof built.deps.cancelBatch).toBe('function')
    expect(typeof built.emit).toBe('function')
    expect(built.dbPath).toBe(':memory:')
    built.handle.close()
  })
})

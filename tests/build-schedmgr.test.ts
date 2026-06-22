// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let hasGo = false
try {
  execFileSync('go', ['version'], { stdio: 'ignore' })
  hasGo = true
} catch {
  hasGo = false
}

describe.skipIf(!hasGo)('build-schedmgr script', () => {
  it('builds the host schedmgr into resources/schedmgr/', () => {
    execFileSync('node', ['scripts/build-schedmgr.mjs'], { cwd: join(__dirname, '..'), stdio: 'inherit' })
    const bin = process.platform === 'win32' ? 'schedmgr.exe' : 'schedmgr'
    expect(existsSync(join(__dirname, '..', 'resources', 'schedmgr', bin))).toBe(true)
  }, 120_000)
})

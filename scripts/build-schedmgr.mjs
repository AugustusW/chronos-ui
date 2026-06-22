// SPDX-License-Identifier: Apache-2.0
// Build the Go schedmgr for the HOST platform into resources/schedmgr/ (electron-builder extraResources to: schedmgr).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'resources', 'schedmgr')
mkdirSync(out, { recursive: true })
const bin = process.platform === 'win32' ? 'schedmgr.exe' : 'schedmgr'
execFileSync('go', ['build', '-o', join(out, bin), '.'], { cwd: join(root, 'schedmgr'), stdio: 'inherit' })
console.log(`built ${join(out, bin)}`)

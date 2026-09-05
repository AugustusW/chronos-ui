// SPDX-License-Identifier: Apache-2.0
// Build the Go schedmgr for the HOST platform, into BOTH places it gets read from:
//
//   resources/schedmgr/  — what electron-builder bundles (extraResources to: schedmgr)
//   schedmgr/            — where resolveSchedmgrPath() looks when the app is NOT packaged
//
// Only the first existed, so `npm run stage:schedmgr` left `npm run dev` with no binary and
// nothing saying why: every job would report a spawn failure at run time. Two Windows verification
// rounds hit this and had to build the dev copy by hand.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'resources', 'schedmgr')
mkdirSync(out, { recursive: true })
const bin = process.platform === 'win32' ? 'schedmgr.exe' : 'schedmgr'
execFileSync('go', ['build', '-o', join(out, bin), '.'], { cwd: join(root, 'schedmgr'), stdio: 'inherit' })
// The dev copy sits next to the Go source, which is exactly where the unpackaged app looks.
const devCopy = join(root, 'schedmgr', bin)
copyFileSync(join(out, bin), devCopy)
console.log(`built ${join(out, bin)}`)
console.log(`copied ${devCopy}  (read by npm run dev)`)

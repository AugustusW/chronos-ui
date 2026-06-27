// SPDX-License-Identifier: Apache-2.0
// Rebuild native addons (better-sqlite3) FROM SOURCE against the bundled Electron's ABI,
// then VERIFY the result actually loads inside the Electron runtime.
//
// Why this exists (see docs/superpowers/chronosUI/specs/2026-06-22-chronos-ui-dogfood-fixes-design.md):
//   1. better-sqlite3 11.10.0's published Electron prebuilt (electron-v132-darwin-arm64) is mis-built
//      upstream — the tarball actually contains a Node-ABI (115) binary. The packaged Electron (132)
//      rejects it at dlopen → the app launches with no window. So prebuilts are NOT trustworthy here.
//   2. electron-builder's own native rebuild (and @electron/rebuild's worker) hangs in this toolchain,
//      so we drive `npm rebuild` directly with the canonical Electron build env vars instead.
//   3. node-gyp 9.x crashes on Python 3.12+ (`distutils` removed); the repo pins node-gyp ^10 via
//      package.json `overrides`, which builds cleanly from source on modern Python.
//
// electron-builder is configured with `npmRebuild: false`; dist:mac / dist:win run this BEFORE packaging.
//
// PLATFORM: this builds a native addon for the HOST platform/arch (better-sqlite3 cannot be
// cross-compiled here). Therefore `dist:win` must be run ON Windows and `dist:mac` ON macOS — matching
// the Plan 7 build runbook. Running `dist:win` on macOS would package a macOS .node into the Windows
// installer; the verification step below will catch an ABI/arch mismatch and fail the build loudly.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronVersion = require('electron/package.json').version

const env = {
  ...process.env,
  npm_config_runtime: 'electron',
  npm_config_target: electronVersion,
  npm_config_disturl: 'https://electronjs.org/headers',
  npm_config_arch: process.arch, // host arch — see PLATFORM note above
  npm_config_build_from_source: 'true'
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
console.log(`[rebuild-native] compiling better-sqlite3 from source for Electron ${electronVersion} (${process.platform}/${process.arch}) …`)
execFileSync(npm, ['rebuild', 'better-sqlite3'], { stdio: 'inherit', env, shell: process.platform === 'win32' })

// Verify the rebuilt addon actually loads + runs INSIDE the Electron runtime (the real packaged
// environment). This is the guard that makes the whole exercise safe: if any of the three failure
// layers above ever re-appears and we end up with a wrong-ABI binary, the build fails HERE — before
// electron-builder packages and notarizes a broken app.
const electronExe = require('electron') // path to the Electron binary
console.log('[rebuild-native] verifying the binary loads inside Electron …')
try {
  execFileSync(
    electronExe,
    ['-e', "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('create table t(x)');db.close()"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: process.cwd(), stdio: 'inherit' }
  )
} catch {
  console.error(
    '[rebuild-native] FATAL: the rebuilt better-sqlite3 does NOT load inside Electron ' +
    `${electronVersion}. Refusing to package a broken binary. If you are on macOS, do not run dist:win ` +
    'here (build Windows on Windows). Otherwise re-run after `npm rebuild better-sqlite3` with a clean cache.'
  )
  process.exit(1)
}
console.log(`[rebuild-native] done — better-sqlite3 verified against Electron ${electronVersion} ABI`)

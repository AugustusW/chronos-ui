// SPDX-License-Identifier: Apache-2.0
// Build-output integration guard.
//
// The App.vue component test stubs `window.chronos`, so it deliberately bypasses the
// real Electron preload bridge — it cannot catch a packaging mismatch between the
// preload path the main process references and the file electron-vite actually emits,
// nor an ESM/sandbox incompatibility. This test builds the app and verifies, against
// the real build artifacts, that:
//   1. the preload file the built main process references actually exists, and
//   2. that preload is CommonJS (Electron sandboxed preload scripts cannot be ESM),
//      which is required because the app enables `sandbox: true`.
import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(projectRoot, 'out')

beforeAll(() => {
  // Self-contained: build so this test is independent of CI step ordering
  // (CI runs the test step before the build step).
  execSync('npx electron-vite build', { cwd: projectRoot, stdio: 'inherit' })
}, 180_000)

function readMainBundle(): string {
  const mainDir = resolve(outDir, 'main')
  const entry = readdirSync(mainDir).find((f) => /^index\.(c?js|mjs)$/.test(f))
  expect(entry, 'a main bundle should be emitted under out/main').toBeTruthy()
  return readFileSync(resolve(mainDir, entry as string), 'utf8')
}

describe('build output: preload bridge', () => {
  it('main references a preload file that actually exists', () => {
    const main = readMainBundle()
    const match = main.match(/preload[/\\](index\.\w+)/)
    expect(match, 'main should reference a preload/index.* file').toBeTruthy()
    const preloadFile = resolve(outDir, 'preload', match![1])
    expect(
      existsSync(preloadFile),
      `main references preload/${match![1]} but that file was not emitted`
    ).toBe(true)
  })

  it('the emitted preload is CommonJS (sandbox-compatible, not ESM)', () => {
    const main = readMainBundle()
    const preloadFile = resolve(outDir, 'preload', main.match(/preload[/\\](index\.\w+)/)![1])
    const preload = readFileSync(preloadFile, 'utf8')
    // CJS bundles use require(); ESM bundles use top-level `import ... from`.
    // Sandboxed preload must be CJS, so require() must be present and there must be
    // no top-level ESM import statement.
    expect(/\brequire\(/.test(preload), 'preload should be CommonJS (use require)').toBe(true)
    expect(/^\s*import\s.+\sfrom\s/m.test(preload), 'preload must not be ESM').toBe(false)
  })
})

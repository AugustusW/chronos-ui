// SPDX-License-Identifier: Apache-2.0
// Build the app ONCE before the whole test run, so the build-output and
// build-migrations specs read a single, stable out/ tree.
//
// Each of those specs used to run `electron-vite build` in its own beforeAll.
// vitest runs test files in parallel, and electron-vite's preload sub-build
// empties out/preload before re-emitting — so two concurrent builds raced:
// build-output could read out/main/index.js (which references preload/index.cjs)
// in the window where the other build had just emptied out/preload. That flaked
// intermittently and far more often on Windows, where file I/O is slower.
// Building once here removes the shared-directory race entirely.
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default function setup(): void {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  execSync('npx electron-vite build', { cwd: projectRoot, stdio: 'inherit' })
}

// SPDX-License-Identifier: Apache-2.0
// Build-output integration guard for drizzle migrations.
//
// Verifies that `electron-vite build` copies the drizzle migrations folder
// (*.sql files + meta/_journal.json) into out/main/migrations, so that the
// packaged app's first-run migrate() call can find them at the path that
// resolveMigrationsPath() returns for a packaged build.
import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

beforeAll(() => {
  // Self-contained: build so this test is independent of CI step ordering.
  execSync('npx electron-vite build', { cwd: projectRoot, stdio: 'inherit' })
}, 180_000)

describe('packaged migrations', () => {
  it('emits .sql files into out/main/migrations', () => {
    const dir = resolve(projectRoot, 'out/main/migrations')
    expect(existsSync(dir), `out/main/migrations should exist`).toBe(true)
    expect(
      readdirSync(dir).some((f) => f.endsWith('.sql')),
      'at least one .sql file should be present in out/main/migrations'
    ).toBe(true)
  })

  it('emits meta/_journal.json into out/main/migrations (required by drizzle migrate())', () => {
    const journal = resolve(projectRoot, 'out/main/migrations/meta/_journal.json')
    expect(
      existsSync(journal),
      'out/main/migrations/meta/_journal.json must exist — drizzle migrate() reads it to know which .sql to apply'
    ).toBe(true)
  })
})

// SPDX-License-Identifier: Apache-2.0
// The README makes no numeric claims, so the whole docs-drift surface of this
// repository is one fact: the newest versioned CHANGELOG entry and
// package.json must name the same version. [Unreleased] is not a version and
// is skipped by the pattern.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('docs consistency', () => {
  it('newest versioned CHANGELOG entry matches package.json', () => {
    const changelog = readFileSync(join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
    const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)
    expect(newest, 'CHANGELOG.md has no "## [x.y.z]" entry').not.toBeNull()
    expect(newest![1]).toBe((pkg as { version: string }).version)
  })
})

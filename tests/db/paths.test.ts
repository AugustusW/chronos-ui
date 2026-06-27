// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { resolveDbPath, resolveMigrationsPaths } from '../../src/main/db/paths'
import { sep } from 'node:path'

// The impl uses path.join (\ on Windows), so normalize the result to / for platform-agnostic assertions.
const norm = (p: string): string => p.split(sep).join('/')

const fakeApp = (over = {}) => ({
  getPath: () => '/Users/me/Library/Application Support/chronos-ui',
  isPackaged: false,
  ...over
})

describe('resolveDbPath', () => {
  it('joins userData with chronos.db', () => {
    expect(norm(resolveDbPath(fakeApp()))).toBe(
      '/Users/me/Library/Application Support/chronos-ui/chronos.db'
    )
  })
})

describe('resolveMigrationsPaths', () => {
  it('dev (unpackaged) resolves both dialect folders under out/main', () => {
    const p = resolveMigrationsPaths(fakeApp({ isPackaged: false }), {
      appRoot: '/proj/chronos-ui',
      resourcesPath: '/ignored'
    })
    expect(norm(p.sqlite)).toBe('/proj/chronos-ui/out/main/migrations')
    expect(norm(p.pg)).toBe('/proj/chronos-ui/out/main/migrations.pg')
  })
  it('prod (packaged) resolves both under resourcesPath asar.unpacked', () => {
    const p = resolveMigrationsPaths(fakeApp({ isPackaged: true }), {
      appRoot: '/ignored',
      resourcesPath: '/app/Contents/Resources'
    })
    expect(norm(p.sqlite)).toBe('/app/Contents/Resources/app.asar.unpacked/out/main/migrations')
    expect(norm(p.pg)).toBe('/app/Contents/Resources/app.asar.unpacked/out/main/migrations.pg')
  })
})

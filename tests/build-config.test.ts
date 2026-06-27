// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pkg from '../package.json'
import { resolveSchedmgrPath } from '../src/main/scheduler/schedmgr-path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const b = (pkg as { build?: Record<string, unknown> }).build ?? {}

describe('electron-builder config', () => {
  it('targets mac dmg + win nsis, no publish', () => {
    expect(b.mac.target).toContain('dmg')
    expect(b.win.target).toContain('nsis')
    expect(b.publish).toBe(null)
  })
  it('pins mac arch to arm64 (plan-advisor I-2; eb25 rejects mac.arch — use defaultArch + --arm64 CLI)', () => {
    expect(b.mac.defaultArch).toBe('arm64')
  })
  it('bundles schedmgr into the schedmgr/ subdir (architect C1)', () => {
    expect(JSON.stringify(b.extraResources)).toContain('"to":"schedmgr"')
  })
  it('bundles the monochrome tray template to the resources root (packaged tray icon path) (#5)', () => {
    const er = JSON.stringify(b.extraResources)
    expect(er).toContain('trayTemplate.png')
    expect(er).toContain('trayTemplate@2x.png')
  })
  it('asar-unpacks better-sqlite3 AND the migrations (architect C2/I1)', () => {
    const unpack = JSON.stringify(b.asarUnpack ?? [])
    expect(unpack).toContain('better-sqlite3')
    expect(unpack).toContain('out/main/migrations')
  })
  it('mac signing wired: hardenedRuntime + entitlements + afterSign notarize hook (architect I3 / plan-advisor C-2)', () => {
    expect(b.mac.hardenedRuntime).toBe(true)
    expect(b.mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(b.afterSign).toBe('scripts/notarize.mjs')
  })
  it('icon assets exist (plan-advisor I-3)', () => {
    expect(existsSync(join(__dirname, '../build/icon.icns'))).toBe(true)
    expect(existsSync(join(__dirname, '../build/icon.ico'))).toBe(true)
  })
  it('monochrome tray template assets exist (#5)', () => {
    expect(existsSync(join(__dirname, '../build/trayTemplate.png'))).toBe(true)
    expect(existsSync(join(__dirname, '../build/trayTemplate@2x.png'))).toBe(true)
  })
})

// plan-advisor I-1: the config `to:schedmgr` subdir must agree with the resolver
describe('schedmgr path agreement', () => {
  it('resolveSchedmgrPath resolves under a schedmgr/ subdir (matches extraResources to:)', () => {
    const p = resolveSchedmgrPath({
      isPackaged: true,
      platform: 'darwin',
      appRoot: '/a',
      resourcesPath: '/r'
    })
    expect(p.replace(/\\/g, '/')).toContain('/schedmgr/')
  })
})

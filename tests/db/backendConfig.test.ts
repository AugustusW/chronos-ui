// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBackendConfig, writeBackendConfig } from '../../src/main/db/backendConfig'

let dir: string
const app = (): { getPath: (n: 'userData') => string } => ({ getPath: () => dir })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chronos-cfg-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('backendConfig', () => {
  it('defaults to sqlite when the file is missing', () => {
    expect(readBackendConfig(app())).toEqual({ backend: 'sqlite' })
  })

  it('round-trips a postgres config', () => {
    writeBackendConfig(app(), { backend: 'postgres', pgService: 'com.augustusw.chronos-ui/pg-dsn' })
    expect(readBackendConfig(app())).toEqual({
      backend: 'postgres',
      pgService: 'com.augustusw.chronos-ui/pg-dsn'
    })
  })

  it('falls back to sqlite on a corrupt file', () => {
    writeFileSync(join(dir, 'chronos-config.json'), '{ not json', 'utf8')
    expect(readBackendConfig(app())).toEqual({ backend: 'sqlite' })
  })

  it('ignores an unknown backend value', () => {
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'mysql' }), 'utf8')
    expect(readBackendConfig(app())).toEqual({ backend: 'sqlite' })
  })

  it('drops a non-string pgService', () => {
    writeFileSync(join(dir, 'chronos-config.json'), JSON.stringify({ backend: 'postgres', pgService: 42 }), 'utf8')
    expect(readBackendConfig(app())).toEqual({ backend: 'postgres' })
  })
})

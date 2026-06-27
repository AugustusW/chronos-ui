// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from 'vitest'
import { createDatabase, type DatabaseHandle } from '../../src/main/db/client'

let handle: DatabaseHandle | undefined
afterEach(async () => {
  await handle?.close()
  handle = undefined
})

describe('createDatabase dialect dispatch', () => {
  it('opens a sqlite handle from a BackendConfig', () => {
    handle = createDatabase({ dialect: 'sqlite', path: ':memory:' })
    expect(handle.dialect).toBe('sqlite')
    expect(handle.sqlite).toBeDefined()
    expect(handle.pool).toBeUndefined()
  })

  it('still accepts a bare path string (sqlite back-compat)', () => {
    handle = createDatabase(':memory:')
    expect(handle.dialect).toBe('sqlite')
    expect(handle.sqlite).toBeDefined()
  })

  it('checkpoint is callable on a sqlite handle', () => {
    handle = createDatabase({ dialect: 'sqlite', path: ':memory:' })
    expect(() => handle!.checkpoint()).not.toThrow()
  })
})

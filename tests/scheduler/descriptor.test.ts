// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { schedmgrDbDescriptor } from '../../src/main/scheduler/descriptor'

describe('schedmgrDbDescriptor', () => {
  it('sqlite config → the sqlite path', () => {
    expect(schedmgrDbDescriptor({ backend: 'sqlite' }, '/db/chronos.db')).toBe('/db/chronos.db')
  })
  it('postgres config with a service → pg:keychain:<service>', () => {
    expect(schedmgrDbDescriptor({ backend: 'postgres', pgService: 'com.x/pg-dsn' }, '/db/chronos.db')).toBe(
      'pg:keychain:com.x/pg-dsn'
    )
  })
  it('postgres without a service → falls back to the sqlite path', () => {
    expect(schedmgrDbDescriptor({ backend: 'postgres' }, '/db/chronos.db')).toBe('/db/chronos.db')
  })
})

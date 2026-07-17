// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest'
import { buildDsn, redactDsn } from '../../src/main/services/pg-dsn'

describe('buildDsn', () => {
  it('builds a postgresql:// URL with sslmode', () => {
    expect(buildDsn({ host: 'db.example.com', port: 5432, database: 'app', user: 'u', password: 'p', sslmode: 'disable' })).toBe(
      'postgresql://u:p@db.example.com:5432/app?sslmode=disable'
    )
  })

  it('encodeURIComponents the user', () => {
    expect(buildDsn({ host: 'h', port: 5432, database: 'db', user: 'sp ace/@u', password: 'p', sslmode: 'require' })).toBe(
      'postgresql://sp%20ace%2F%40u:p@h:5432/db?sslmode=require'
    )
  })

  it('encodeURIComponents special characters in the password (@ : / # ?)', () => {
    const dsn = buildDsn({ host: 'h', port: 5432, database: 'db', user: 'u', password: 'p@ss:w/o#rd?', sslmode: 'require' })
    expect(dsn).toBe('postgresql://u:p%40ss%3Aw%2Fo%23rd%3F@h:5432/db?sslmode=require')
  })

  it('brackets a bare IPv6 host', () => {
    expect(buildDsn({ host: '2001:db8::1', port: 5432, database: 'db', user: 'u', password: 'p', sslmode: 'require' })).toBe(
      'postgresql://u:p@[2001:db8::1]:5432/db?sslmode=require'
    )
  })

  it('does not double-bracket an already-bracketed IPv6 host', () => {
    expect(buildDsn({ host: '[::1]', port: 5432, database: 'db', user: 'u', password: 'p', sslmode: 'require' })).toBe(
      'postgresql://u:p@[::1]:5432/db?sslmode=require'
    )
  })

  it('leaves a plain hostname unbracketed', () => {
    expect(buildDsn({ host: 'localhost', port: 5432, database: 'db', user: 'u', password: 'p', sslmode: 'disable' })).toBe(
      'postgresql://u:p@localhost:5432/db?sslmode=disable'
    )
  })
})

describe('redactDsn', () => {
  it('replaces the password segment with *** and leaks nothing', () => {
    const dsn = buildDsn({ host: '2001:db8::1', port: 5432, database: 'app', user: 'u', password: 'sup3r$ecr3t', sslmode: 'verify-full' })
    const redacted = redactDsn(dsn)
    expect(redacted).toBe('postgresql://u:***@[2001:db8::1]:5432/app?sslmode=verify-full')
    expect(redacted).not.toContain('sup3r')
  })

  it('redacts a password containing encoded special characters without leaking it', () => {
    const dsn = buildDsn({ host: 'h', port: 5432, database: 'db', user: 'u', password: 'p@ss:w/o#rd?', sslmode: 'require' })
    const redacted = redactDsn(dsn)
    expect(redacted).toBe('postgresql://u:***@h:5432/db?sslmode=require')
    expect(redacted).not.toContain('p%40ss%3Aw%2Fo%23rd%3F')
  })

  it('leaves host/port/db/query untouched', () => {
    const dsn = buildDsn({ host: 'db.example.com', port: 5433, database: 'app', user: 'u', password: 'p', sslmode: 'require' })
    expect(redactDsn(dsn)).toBe('postgresql://u:***@db.example.com:5433/app?sslmode=require')
  })

  it('is a no-op on a DSN with no userinfo', () => {
    expect(redactDsn('postgresql://host:5432/db')).toBe('postgresql://host:5432/db')
  })
})

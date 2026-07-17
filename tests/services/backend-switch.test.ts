// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import { testConnection, type PgClientLike } from '../../src/main/services/backend-switch'

function fakeClient(over: Partial<PgClientLike> = {}): PgClientLike {
  return {
    connect: vi.fn(async () => {}),
    query: vi.fn(async () => ({ rows: [{ version: 'PostgreSQL 16.4' }] })),
    end: vi.fn(async () => {}),
    ...over
  }
}

describe('testConnection (unit, mocked pg.Client)', () => {
  it('returns ok + version + elapsed ms on a successful connect', async () => {
    const client = fakeClient()
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:p@host:5432/db', factory)
    expect(factory).toHaveBeenCalledWith('postgresql://u:p@host:5432/db')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.version).toBe('PostgreSQL 16.4')
      expect(res.ms).toBeGreaterThanOrEqual(0)
    }
    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.query).toHaveBeenCalledWith('SELECT version()')
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('returns ok:false with a redacted error when connect() rejects', async () => {
    const client = fakeClient({ connect: vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432') }) })
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:p@host:5432/db', factory)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('connect ECONNREFUSED 127.0.0.1:5432')
    // client.end is still attempted (best-effort cleanup) even though connect failed.
    expect(client.end).toHaveBeenCalledOnce()
  })

  it('redacts the password if the underlying driver error embeds the raw DSN', async () => {
    const client = fakeClient({
      connect: vi.fn(async () => {
        throw new Error('invalid connection string: postgresql://u:SECRET@host:5432/db')
      })
    })
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:SECRET@host:5432/db', factory)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).not.toContain('SECRET')
      expect(res.error).toContain('***')
    }
  })

  it('returns ok:false when query() rejects (e.g. auth failure after connect)', async () => {
    const client = fakeClient({ query: vi.fn(async () => { throw new Error('password authentication failed for user "u"') }) })
    const factory = vi.fn(() => client)
    const res = await testConnection('postgresql://u:p@host:5432/db', factory)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('password authentication failed for user "u"')
  })
})

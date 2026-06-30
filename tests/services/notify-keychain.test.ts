// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest'
import {
  NOTIFY_TOKEN_SERVICE,
  keychainWriteSupported,
  writeCommand,
  readCommand,
  deleteCommand,
  keychainStore,
  keychainRead
} from '../../src/main/services/notify-keychain'

describe('keychain command builders', () => {
  it('shares the service name with the Go schedmgr reader', () => {
    // schedmgr/secret.go: const notifyTokenService = "chronos-ui-notify-token"
    expect(NOTIFY_TOKEN_SERVICE).toBe('chronos-ui-notify-token')
  })

  it('darwin uses security add/find/delete (default ACL — no -A)', () => {
    // No `stdin`: /usr/bin/security has no stdin-password option, so the token is a CLI arg (-w) on
    // macOS (briefly visible in `ps`). Linux below uses stdin instead. toEqual asserts stdin is absent.
    expect(writeCommand('darwin', NOTIFY_TOKEN_SERVICE, 'chronos-ui', '123:ABC')).toEqual({
      cmd: 'security',
      args: ['add-generic-password', '-U', '-s', 'chronos-ui-notify-token', '-a', 'chronos-ui', '-w', '123:ABC']
    })
    expect(readCommand('darwin', NOTIFY_TOKEN_SERVICE)).toEqual({
      cmd: 'security',
      args: ['find-generic-password', '-s', 'chronos-ui-notify-token', '-w']
    })
    expect(deleteCommand('darwin', NOTIFY_TOKEN_SERVICE)).toEqual({
      cmd: 'security',
      args: ['delete-generic-password', '-s', 'chronos-ui-notify-token']
    })
  })

  it('linux uses secret-tool with the token on stdin', () => {
    const w = writeCommand('linux', NOTIFY_TOKEN_SERVICE, 'chronos-ui', '123:ABC')
    expect(w?.cmd).toBe('secret-tool')
    expect(w?.args.slice(0, 2)).toEqual(['store', '--label=ChronosUI notify token'])
    expect(w?.args).toContain('service')
    expect(w?.args).toContain('chronos-ui-notify-token')
    expect(w?.stdin).toBe('123:ABC') // secret-tool reads the secret from stdin, never argv
    expect(readCommand('linux', NOTIFY_TOKEN_SERVICE)).toEqual({
      cmd: 'secret-tool',
      args: ['lookup', 'service', 'chronos-ui-notify-token']
    })
  })

  it('windows / unsupported → null (no keychain write path)', () => {
    expect(keychainWriteSupported('win32')).toBe(false)
    expect(keychainWriteSupported('darwin')).toBe(true)
    expect(keychainWriteSupported('linux')).toBe(true)
    expect(writeCommand('win32', NOTIFY_TOKEN_SERVICE, 'chronos-ui', 'x')).toBeNull()
    expect(readCommand('win32', NOTIFY_TOKEN_SERVICE)).toBeNull()
  })
})

describe('keychainStore / keychainRead', () => {
  it('store returns true when exec exits 0 and passes the token via stdin on linux', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }))
    const ok = await keychainStore(exec, 'linux', NOTIFY_TOKEN_SERVICE, 'chronos-ui', '123:ABC')
    expect(ok).toBe(true)
    expect(exec).toHaveBeenCalledWith('secret-tool', expect.arrayContaining(['store']), '123:ABC')
  })

  it('store returns false on an unsupported platform without invoking exec', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' }))
    expect(await keychainStore(exec, 'win32', NOTIFY_TOKEN_SERVICE, 'chronos-ui', 'x')).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('store returns false when exec exits non-zero (so caller falls back to file)', async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: 'denied' }))
    expect(await keychainStore(exec, 'darwin', NOTIFY_TOKEN_SERVICE, 'chronos-ui', 'x')).toBe(false)
  })

  it('store returns false (never throws) when exec rejects', async () => {
    const exec = vi.fn(async () => { throw new Error('ENOENT security') })
    expect(await keychainStore(exec, 'darwin', NOTIFY_TOKEN_SERVICE, 'chronos-ui', 'x')).toBe(false)
  })

  it('read returns trimmed stdout on success; null on failure / empty / unsupported', async () => {
    expect(await keychainRead(vi.fn(async () => ({ code: 0, stdout: '123:ABC\n' })), 'darwin', NOTIFY_TOKEN_SERVICE)).toBe('123:ABC')
    expect(await keychainRead(vi.fn(async () => ({ code: 1, stdout: '' })), 'darwin', NOTIFY_TOKEN_SERVICE)).toBeNull()
    expect(await keychainRead(vi.fn(async () => ({ code: 0, stdout: '   ' })), 'darwin', NOTIFY_TOKEN_SERVICE)).toBeNull()
    expect(await keychainRead(vi.fn(async () => ({ code: 0, stdout: 'x' })), 'win32', NOTIFY_TOKEN_SERVICE)).toBeNull()
  })

  it('read returns null (never throws) when exec rejects', async () => {
    const exec = vi.fn(async () => { throw new Error('boom') })
    expect(await keychainRead(exec, 'darwin', NOTIFY_TOKEN_SERVICE)).toBeNull()
  })
})

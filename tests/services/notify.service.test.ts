import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, existsSync } from 'node:fs'
import { createNotifyService, type NotifyServiceDeps } from '../../src/main/services/notify.service'
import type { Repositories } from '../../src/main/db/repositories'
import type { NotifySettingsInput } from '../../src/main/db/notifySettings.repository'
import type { FlushScheduler } from '../../src/main/services/notify-flush-launchd'

function fakeRepos() {
  let saved = { enabled: false, chatId: null as string | null, windowMin: 0, updatedAt: null as Date | null }
  return {
    notifySettings: {
      get: async () => saved,
      save: async (i: NotifySettingsInput) => { saved = { ...i, updatedAt: new Date() }; return saved }
    }
  } as unknown as Repositories
}
function fakeFlushScheduler() {
  return { install: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) } as unknown as FlushScheduler
}
const baseDeps = (over: Partial<NotifyServiceDeps> = {}): NotifyServiceDeps => ({
  repos: fakeRepos(), flushScheduler: fakeFlushScheduler(),
  schedmgrPath: '/opt/schedmgr', schedmgrDescriptor: '/db/chronos.db',
  secretDir: mkdtempSync(join(tmpdir(), 'chronos-notify-')),
  fetchFn: vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' })) as unknown as typeof fetch,
  spawnFlush: vi.fn(async () => {}),
  // Default to win32 so the base fixtures exercise the 0600-file fallback path (keychain unsupported);
  // the keychain-specific suite below overrides platform: 'darwin' with a mock execKeychain.
  platform: 'win32',
  execKeychain: vi.fn(async () => ({ code: 1, stdout: '' })),
  logWarn: () => {},
  ...over
})

describe('notify service', () => {
  it('getSettings reports tokenSet=false initially', async () => {
    const svc = createNotifyService(baseDeps())
    expect(await svc.getSettings()).toMatchObject({ enabled: false, tokenSet: false })
  })

  it('saveSettings writes the token file and reports tokenSet=true', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: 'BOT:1' })
    expect(existsSync(join(deps.secretDir, 'chronos-ui-notify-token.secret'))).toBe(true)
    expect((await svc.getSettings()).tokenSet).toBe(true)
  })

  it('immediate mode (windowMin 0) removes the flush entry', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: 'BOT:1' })
    expect(deps.flushScheduler.remove).toHaveBeenCalled()
    expect(deps.flushScheduler.install).not.toHaveBeenCalled()
  })

  it('batched mode installs the flush entry with the window', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 5, token: 'BOT:1' })
    expect(deps.flushScheduler.install).toHaveBeenCalledWith(5)
  })

  it('disabling removes the flush entry', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: false, chatId: '42', windowMin: 5 })
    expect(deps.flushScheduler.remove).toHaveBeenCalled()
  })

  it('testSend posts to sendMessage and returns ok', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: '123456789:ABCdef_-' })
    const r = await svc.testSend()
    expect(r.ok).toBe(true)
    expect(deps.fetchFn).toHaveBeenCalled()
  })

  it('testSend fails cleanly with no token', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0 }) // no token
    const r = await svc.testSend()
    expect(r.ok).toBe(false)
  })

  it('testSend rejects a tampered/invalid-format token without hitting the network (code review #2)', async () => {
    const deps = baseDeps()
    const svc = createNotifyService(deps)
    // saveSettings does not validate (the IPC boundary does); simulate a hand-tampered .secret file
    // whose value would reshape the api.telegram.org URL path.
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: 'evil/../sendMessage' })
    const r = await svc.testSend()
    expect(r.ok).toBe(false)
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('pre-save drain: spawnFlush is awaited BEFORE notifySettings.save when disabling from batched state', async () => {
    // Arrange: prev state is batched-enabled (enabled=true, windowMin=5)
    const callOrder: string[] = []

    let saved = { enabled: true, chatId: '42', windowMin: 5, updatedAt: new Date() }
    const repos = {
      notifySettings: {
        get: async () => ({ ...saved }),
        save: async (i: NotifySettingsInput) => {
          callOrder.push('save')
          saved = { ...i, updatedAt: new Date() }
          return saved
        }
      }
    } as unknown as Repositories

    const spawnFlush = vi.fn(async () => { callOrder.push('spawnFlush') })

    const deps: NotifyServiceDeps = {
      repos,
      flushScheduler: fakeFlushScheduler(),
      schedmgrPath: '/opt/schedmgr',
      schedmgrDescriptor: '/db/chronos.db',
      secretDir: mkdtempSync(join(tmpdir(), 'chronos-notify-order-')),
      fetchFn: vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch,
      spawnFlush,
      platform: 'win32',
      execKeychain: vi.fn(async () => ({ code: 1, stdout: '' })),
      logWarn: () => {}
    }

    const svc = createNotifyService(deps)

    // Act: disable (new state: enabled=false)
    await svc.saveSettings({ enabled: false, chatId: '42', windowMin: 5 })

    // Assert: spawnFlush was called, and its marker precedes save's marker
    expect(callOrder).toContain('spawnFlush')
    expect(callOrder).toContain('save')
    expect(callOrder.indexOf('spawnFlush')).toBeLessThan(callOrder.indexOf('save'))
  })

  it('pre-save drain: spawnFlush is NOT called when prev state is not batched (windowMin=0)', async () => {
    // prev state: enabled=true but windowMin=0 (immediate mode, not batched)
    let saved = { enabled: true, chatId: '42', windowMin: 0, updatedAt: new Date() }
    const repos = {
      notifySettings: {
        get: async () => ({ ...saved }),
        save: async (i: NotifySettingsInput) => { saved = { ...i, updatedAt: new Date() }; return saved }
      }
    } as unknown as Repositories

    const spawnFlush = vi.fn(async () => {})

    const deps: NotifyServiceDeps = {
      repos,
      flushScheduler: fakeFlushScheduler(),
      schedmgrPath: '/opt/schedmgr',
      schedmgrDescriptor: '/db/chronos.db',
      secretDir: mkdtempSync(join(tmpdir(), 'chronos-notify-nobatch-')),
      fetchFn: vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch,
      spawnFlush,
      platform: 'win32',
      execKeychain: vi.fn(async () => ({ code: 1, stdout: '' })),
      logWarn: () => {}
    }

    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: false, chatId: '42', windowMin: 0 })

    // spawnFlush should NOT be called when prev state is not batched
    expect(spawnFlush).not.toHaveBeenCalled()
  })

  it('pre-save drain failure does not block save (best-effort)', async () => {
    let saved = { enabled: true, chatId: '42', windowMin: 5, updatedAt: new Date() }
    const repos = {
      notifySettings: {
        get: async () => ({ ...saved }),
        save: async (i: NotifySettingsInput) => { saved = { ...i, updatedAt: new Date() }; return saved }
      }
    } as unknown as Repositories

    const spawnFlush = vi.fn(async () => { throw new Error('schedmgr timed out') })

    const deps: NotifyServiceDeps = {
      repos,
      flushScheduler: fakeFlushScheduler(),
      schedmgrPath: '/opt/schedmgr',
      schedmgrDescriptor: '/db/chronos.db',
      secretDir: mkdtempSync(join(tmpdir(), 'chronos-notify-fail-')),
      fetchFn: vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch,
      spawnFlush,
      platform: 'win32',
      execKeychain: vi.fn(async () => ({ code: 1, stdout: '' })),
      logWarn: () => {}
    }

    const svc = createNotifyService(deps)

    // Should NOT throw — drain failure is best-effort
    const result = await svc.saveSettings({ enabled: false, chatId: '42', windowMin: 5 })
    expect(result.ok).toBe(true)
    // flushWarning should carry the drain error message
    expect(result.flushWarning).toContain('schedmgr timed out')
    // Save still completed (new state is disabled)
    expect(saved.enabled).toBe(false)
  })
})

describe('notify service — keychain storage (code review #1 / W2)', () => {
  it('on macOS, saveSettings stores the token in the keychain and writes NO plaintext file', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '' })) // keychain store succeeds
    const deps = baseDeps({ platform: 'darwin', execKeychain: exec })
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: '123456789:ABCdef_-' })
    // keychain write was issued via `security add-generic-password`
    expect(exec).toHaveBeenCalledWith('security', expect.arrayContaining(['add-generic-password']), undefined)
    // and the plaintext fallback file was NOT created
    expect(existsSync(join(deps.secretDir, 'chronos-ui-notify-token.secret'))).toBe(false)
  })

  it('reports tokenStorage="keychain" when the keychain holds the token', async () => {
    const exec = vi.fn(async (_c: string, args: string[]) =>
      args[0] === 'find-generic-password' ? { code: 0, stdout: '123456789:ABCdef_-\n' } : { code: 0, stdout: '' }
    )
    const dto = await createNotifyService(baseDeps({ platform: 'darwin', execKeychain: exec })).getSettings()
    expect(dto.tokenSet).toBe(true)
    expect(dto.tokenStorage).toBe('keychain')
  })

  it('falls back to the 0600 file and warns when the keychain write fails', async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: 'denied' })) // store fails, read finds nothing
    const warn = vi.fn()
    const deps = baseDeps({ platform: 'darwin', execKeychain: exec, logWarn: warn })
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: '123456789:ABCdef_-' })
    expect(existsSync(join(deps.secretDir, 'chronos-ui-notify-token.secret'))).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNENCRYPTED'))
    expect((await svc.getSettings()).tokenStorage).toBe('file')
  })

  it('on Windows, warns and stores in the 0600 file (keychain unsupported)', async () => {
    const warn = vi.fn()
    const deps = baseDeps({ platform: 'win32', logWarn: warn })
    const svc = createNotifyService(deps)
    await svc.saveSettings({ enabled: true, chatId: '42', windowMin: 0, token: '123456789:ABCdef_-' })
    expect(deps.execKeychain).not.toHaveBeenCalled() // never even tries the keychain
    expect(existsSync(join(deps.secretDir, 'chronos-ui-notify-token.secret'))).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNENCRYPTED'))
    expect((await svc.getSettings()).tokenStorage).toBe('file')
  })

  it('testSend reads the token from the keychain (not the file) on macOS', async () => {
    const exec = vi.fn(async (_c: string, args: string[]) =>
      args[0] === 'find-generic-password' ? { code: 0, stdout: '123456789:ABCdef_-\n' } : { code: 0, stdout: '' }
    )
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })) as unknown as typeof fetch
    const repos = (() => {
      const saved = { enabled: true, chatId: '42', windowMin: 0, updatedAt: new Date() }
      return { notifySettings: { get: async () => saved, save: async () => saved } } as unknown as Repositories
    })()
    const svc = createNotifyService(baseDeps({ platform: 'darwin', execKeychain: exec, fetchFn, repos }))
    const r = await svc.testSend()
    expect(r.ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/bot123456789:ABCdef_-/sendMessage'), expect.anything())
  })
})

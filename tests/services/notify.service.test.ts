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
      spawnFlush
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
      spawnFlush
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
      spawnFlush
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

// SPDX-License-Identifier: Apache-2.0
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { installCrashGuards } from './crash-guards'
import { buildMainDeps, BootPgUnreachableError, handleBootPgUnreachable, type BuiltDeps } from './bootstrap'
import { createQuitGuard } from './quit-guard'
import { registerIpcHandlers } from './ipc'
import { startCheckpointTimer, startRetentionSweep, pgQuitDrain } from './db/lifecycle'
import { watchDbForChanges } from './db/watch'
import type { DatabaseHandle } from './db/client'
import { createTray, type TrayHandle } from './tray'
import { createNativeNotifyService, createElectronNotifier, type NativeNotifyHandle } from './services/native-notify.service'
import { installNavigationHardening } from './window-security'
import type { RunEvent } from '../shared/ipc-contract'
import type { SaveDialogOptions, OpenDialogOptions } from 'electron'

// Install crash guards as early as possible: a stray uncaught error in main must surface a visible,
// debuggable dialog (ChronosUI is a developer tool) rather than silently quitting the app.
installCrashGuards({ process, app, showError: (title, content) => dialog.showErrorBox(title, content) })

let dbHandle: DatabaseHandle | null = null
let stopCheckpoint: (() => void) | null = null
let stopRetention: (() => void) | null = null
let stopWatch: (() => void) | null = null
let poll: ReturnType<typeof setInterval> | null = null
let tray: TrayHandle | null = null        // module-scope so V8 doesn't GC the Tray (architect I4)
let nativeNotify: NativeNotifyHandle | null = null
const quitGuard = createQuitGuard({ quit: () => app.quit(), platform: process.platform })

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (quitGuard.shouldInterceptClose()) { e.preventDefault(); win.hide() }
  })
  // Navigation lockdown (code review #3): deny in-app popups (open http(s) in the OS browser instead)
  // and prevent the main window from being navigated away from the app's own page.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const appUrl = rendererUrl ?? pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
  installNavigationHardening(win.webContents, () => appUrl, (u) => { void shell.openExternal(u) })
  if (rendererUrl) win.loadURL(rendererUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  // Boot deps: getWebContents (live-run emitter target) + relaunchApp/exitApp (T13's pg
  // settings-UI save/switch needs both after a successful backend switch). Shared between the
  // initial attempt and the T12 session-only sqlite fallback below, so both boot the SAME way.
  const bootOpts = {
    getWebContents: () => BrowserWindow.getAllWindows()[0]?.webContents,
    relaunchApp: () => app.relaunch(),
    exitApp: () => app.exit(),
    quitApp: () => quitGuard.requestQuit(),
    // v0.4.0: fan the SAME RunEvent stream the renderer gets out to the tray + native-failure
    // notifier too (neither is created yet at this point in boot — both are module-scope `let`s, so
    // this closure sees whatever they're assigned to by the time an event actually fires, same as
    // the tray?.destroy() pattern already used in the before-quit handler below).
    onRunEvent: (e: RunEvent) => {
      tray?.applyRunEvent(e)
      nativeNotify?.applyRunEvent(e)
    },
    // v0.4.0: YAML export/import file dialogs — real electron.dialog, parented to the main window
    // when one exists (BuildOpts defaults to "always canceled" for callers, like most tests, that
    // never supply these).
    showSaveDialog: (opts: SaveDialogOptions) => {
      const w = BrowserWindow.getAllWindows()[0]
      return w ? dialog.showSaveDialog(w, opts) : dialog.showSaveDialog(opts)
    },
    showOpenDialog: (opts: OpenDialogOptions) => {
      const w = BrowserWindow.getAllWindows()[0]
      const full: OpenDialogOptions = { ...opts, properties: ['openFile'] }
      return w ? dialog.showOpenDialog(w, full) : dialog.showOpenDialog(full)
    }
  }
  let built: BuiltDeps
  try {
    built = await buildMainDeps(app, bootOpts)
  } catch (err) {
    // T12: a postgres backend configured but unreachable at boot is NEVER silently downgraded to
    // sqlite — put up a blocking dialog and let the user choose. Any other boot failure is a real
    // bug, not a user-facing config problem, so it is rethrown (installCrashGuards' unhandledRejection
    // guard — or the thrown error surfacing as a rejected whenReady().then() — reports it visibly).
    if (!(err instanceof BootPgUnreachableError)) throw err
    const fallback = await handleBootPgUnreachable(err, {
      showMessageBox: (opts) => dialog.showMessageBox(opts),
      quit: () => app.quit(),
      buildSqliteFallback: () => buildMainDeps(app, { ...bootOpts, forceSqlite: true })
    })
    if (!fallback) return // user chose Quit — handleBootPgUnreachable already called app.quit()
    built = fallback
  }
  dbHandle = built.handle
  dbHandle.checkpoint() // passive checkpoint on open (spec §7)
  stopCheckpoint = startCheckpointTimer(dbHandle)
  // Bound the otherwise insert-only run history: prune on launch + daily while open (review #4).
  stopRetention = startRetentionSweep(built.pruneRunLogs, {
    onError: (e) => console.warn('chronos: run-log retention sweep failed:', e)
  })
  registerIpcHandlers(built.deps)
  createWindow()
  const showWin = (): void => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus() } else createWindow() }
  tray = createTray({
    onOpen: showWin,
    onQuit: () => quitGuard.requestQuit(),
    // Monochrome menu-bar template (#5): the "…Template" filename makes Electron auto-render it for
    // light/dark menu bars. NOT the full color app icon (which renders oversized + wrong in the tray).
    iconPath: app.isPackaged ? join(process.resourcesPath, 'trayTemplate.png') : join(__dirname, '../../build/trayTemplate.png'),
    // v0.4.0: reuses dashboard.service.ts's query functions via the SAME bootstrap.ts-assembled
    // deps the IPC handler calls — no separate SQL/logic. Deep-nav into run history isn't wired
    // (see tray-menu.ts's onOpenJob doc); opening the window onto the Dashboard is enough.
    getSummary: built.deps.dashboardSummary,
    onOpenJob: () => showWin()
  })
  // v0.4.0: macOS native failure notification — reuses the same dashboard-repository query layer
  // (built.listRunOutcomesSince) and the same notify_settings row (built.deps.notify.getSettings)
  // the Telegram notifier's Settings panel already writes to; see native-notify.service.ts for the
  // failure/schedule-only decision this mirrors from schedmgr/notify.go.
  nativeNotify = createNativeNotifyService({
    listRunOutcomes: built.listRunOutcomesSince,
    getNativeEnabled: async () => (await built.deps.notify.getSettings()).nativeEnabled,
    notifier: createElectronNotifier(),
    onOpen: showWin
  })
  stopWatch = watchDbForChanges(built.dbPath, () => built.emit({ kind: 'jobsChanged' }))
  poll = setInterval(() => built.emit({ kind: 'jobsChanged' }), 45_000)
  poll.unref?.()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (e) => {
  tray?.destroy(); tray = null
  nativeNotify = null // no OS resource to release (unlike tray's icon) — just stop the RunEvent hook
  stopCheckpoint?.()
  stopRetention?.()
  stopWatch?.()
  if (poll) clearInterval(poll)
  dbHandle?.checkpoint()
  // T12: a postgres pool needs its drain (pool.end()) awaited before the process actually exits —
  // pgQuitDrain returns null for sqlite (whose close() is synchronous internally, so the existing
  // fire-and-forget below stays correct and simplest for that case).
  const drain = pgQuitDrain(dbHandle, app)
  if (drain) {
    e.preventDefault()
    // Guard against re-entry: drain() calls app.quit() again once it settles, which re-fires this
    // same 'before-quit' listener. Nulling dbHandle first means the SECOND firing sees no postgres
    // handle to drain (pgQuitDrain returns null) and falls through to the plain close() below,
    // which is a no-op on a null handle — so the quit actually completes instead of looping.
    dbHandle = null
    void drain()
  } else {
    void dbHandle?.close()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

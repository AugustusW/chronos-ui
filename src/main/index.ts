// SPDX-License-Identifier: Apache-2.0
import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { installCrashGuards } from './crash-guards'
import { buildMainDeps } from './bootstrap'
import { registerIpcHandlers } from './ipc'
import { startCheckpointTimer, startRetentionSweep } from './db/lifecycle'
import { watchDbForChanges } from './db/watch'
import type { DatabaseHandle } from './db/client'
import { createTray, type TrayHandle } from './tray'
import { installNavigationHardening } from './window-security'

// Install crash guards as early as possible: a stray uncaught error in main must surface a visible,
// debuggable dialog (ChronosUI is a developer tool) rather than silently quitting the app.
installCrashGuards({ process, app, showError: (title, content) => dialog.showErrorBox(title, content) })

let dbHandle: DatabaseHandle | null = null
let stopCheckpoint: (() => void) | null = null
let stopRetention: (() => void) | null = null
let stopWatch: (() => void) | null = null
let poll: ReturnType<typeof setInterval> | null = null
let tray: TrayHandle | null = null        // module-scope so V8 doesn't GC the Tray (architect I4)
let isQuitting = false

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
    if (!isQuitting && process.platform !== 'darwin') { e.preventDefault(); win.hide() }
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
  const built = await buildMainDeps(app, { getWebContents: () => BrowserWindow.getAllWindows()[0]?.webContents })
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
    onQuit: () => { isQuitting = true; app.quit() },
    // Monochrome menu-bar template (#5): the "…Template" filename makes Electron auto-render it for
    // light/dark menu bars. NOT the full color app icon (which renders oversized + wrong in the tray).
    iconPath: app.isPackaged ? join(process.resourcesPath, 'trayTemplate.png') : join(__dirname, '../../build/trayTemplate.png')
  })
  stopWatch = watchDbForChanges(built.dbPath, () => built.emit({ kind: 'jobsChanged' }))
  poll = setInterval(() => built.emit({ kind: 'jobsChanged' }), 45_000)
  poll.unref?.()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  tray?.destroy(); tray = null
  stopCheckpoint?.()
  stopRetention?.()
  stopWatch?.()
  if (poll) clearInterval(poll)
  dbHandle?.checkpoint()
  // SQLite close() is synchronous internally (resolved promise), so this completes during quit.
  // Plan 3 (postgres backend) will need the e.preventDefault()+app.quit() pattern to truly await
  // pool.end() before exiting; for the sqlite default the floating promise is intentional.
  void dbHandle?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

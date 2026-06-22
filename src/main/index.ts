// SPDX-License-Identifier: Apache-2.0
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { buildMainDeps } from './bootstrap'
import { registerIpcHandlers } from './ipc'
import { startCheckpointTimer } from './db/lifecycle'
import { watchDbForChanges } from './db/watch'
import type { DatabaseHandle } from './db/client'
import { createTray, type TrayHandle } from './tray'

let dbHandle: DatabaseHandle | null = null
let stopCheckpoint: (() => void) | null = null
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
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  const built = buildMainDeps(app, { getWebContents: () => BrowserWindow.getAllWindows()[0]?.webContents })
  dbHandle = built.handle
  dbHandle.checkpoint() // passive checkpoint on open (spec §7)
  stopCheckpoint = startCheckpointTimer(dbHandle)
  registerIpcHandlers(built.deps)
  createWindow()
  const showWin = (): void => { const w = BrowserWindow.getAllWindows()[0]; if (w) { w.show(); w.focus() } else createWindow() }
  tray = createTray({
    onOpen: showWin,
    onQuit: () => { isQuitting = true; app.quit() },
    iconPath: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png')
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
  stopWatch?.()
  if (poll) clearInterval(poll)
  dbHandle?.checkpoint()
  dbHandle?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

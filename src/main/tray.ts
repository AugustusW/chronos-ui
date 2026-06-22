// SPDX-License-Identifier: Apache-2.0
import { Tray, Menu } from 'electron'

export interface TrayLike { (iconPath: string): { setToolTip(s: string): void; setContextMenu(m: unknown): void; on(ev: string, cb: () => void): void; destroy(): void } }
export interface MenuLike { buildFromTemplate(tpl: Array<{ label: string; click: () => void }>): unknown }
export interface TrayDeps { onOpen: () => void; onQuit: () => void; iconPath: string; TrayCtor?: TrayLike; Menu?: MenuLike }
export interface TrayHandle { destroy(): void }

/** Build the system tray (Plan 7). Injectable so it unit-tests without a display. */
export function createTray(deps: TrayDeps): TrayHandle {
  const Ctor = deps.TrayCtor ?? ((p: string) => new Tray(p) as unknown as ReturnType<TrayLike>)
  const M = deps.Menu ?? Menu
  const tray = Ctor(deps.iconPath)
  tray.setToolTip('ChronosUI')
  tray.setContextMenu(M.buildFromTemplate([
    { label: 'Open ChronosUI', click: () => deps.onOpen() },
    { label: 'Quit', click: () => deps.onQuit() }
  ]))
  tray.on('click', () => deps.onOpen())
  return { destroy: () => tray.destroy() }
}

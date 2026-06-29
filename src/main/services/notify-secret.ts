// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'
import * as pathWin32 from 'node:path/win32'
import { mkdirSync, writeFileSync } from 'node:fs'

/** Mirror Go's os.UserConfigDir() then append "chronos-ui" — MUST match schedmgr secret.go
 *  defaultFallbackDir() (NOT Electron userData, which is .../ChronosUI). */
export function goSecretDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homedir: string): string {
  if (platform === 'win32') {
    // Use || (not ??) so an empty string falls back like Go's os.UserConfigDir() treats empty APPDATA.
    const base = env.APPDATA || pathWin32.join(homedir, 'AppData', 'Roaming')
    return pathWin32.join(base, 'chronos-ui')
  }
  let base: string
  if (platform === 'darwin') base = join(homedir, 'Library', 'Application Support')
  // Use || (not ??) so an empty string falls back like Go's os.UserConfigDir() treats empty XDG_CONFIG_HOME.
  else base = env.XDG_CONFIG_HOME || join(homedir, '.config')
  return join(base, 'chronos-ui')
}

export const NOTIFY_TOKEN_FILE = 'chronos-ui-notify-token.secret'

export function writeNotifyToken(dir: string, token: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, NOTIFY_TOKEN_FILE), token, { mode: 0o600 })
}

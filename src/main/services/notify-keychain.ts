// SPDX-License-Identifier: Apache-2.0
//
// OS keychain WRITE for the Telegram bot token — the missing half of what the Go schedmgr already
// READS (schedmgr/secret.go: keychain-first, then a 0600 fallback file). Before this, the Electron
// side only ever wrote the plaintext fallback file, so the keychain read always missed and the token
// always landed in plaintext. Here we mirror the Go reader's commands so Electron writes the same
// keychain item the schedmgr binary reads at cron time:
//
//   macOS:  security add-generic-password ... / find-generic-password -s <svc> -w
//   Linux:  secret-tool store/lookup service <svc>
//
// Both sides shell out to the same system binary (/usr/bin/security, secret-tool), which is the
// keychain ACL subject — so the default-ACL item the GUI writes is readable by the cron-spawned
// schedmgr read without a GUI prompt (verified on macOS; that's why we deliberately do NOT pass `-A`,
// which would weaken the item to "any app"). Windows keychain write is not implemented (the Go read
// is a stub there too), so the caller keeps the 0600 file fallback + a loud warning.
//
// Electron-free + exec injected, so it is unit-testable headlessly.

/** The keychain service name. MUST equal schedmgr/secret.go's notifyTokenService. */
export const NOTIFY_TOKEN_SERVICE = 'chronos-ui-notify-token'

/** Runs a command with optional stdin; resolves the exit code + stdout. Never expected to reject for
 *  a non-zero exit (that is reported via `code`), but callers tolerate rejection too. */
export type ExecFn = (cmd: string, args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

/** Whether this platform has a keychain ChronosUI can WRITE to (mirrors the Go read support). */
export function keychainWriteSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux'
}

export interface KeychainCommand {
  cmd: string
  args: string[]
  /** Secret passed on stdin instead of argv (Linux secret-tool), so it never appears in the process list. */
  stdin?: string
}

export function writeCommand(
  platform: NodeJS.Platform,
  service: string,
  account: string,
  token: string
): KeychainCommand | null {
  if (platform === 'darwin') {
    // -U updates an existing item (matched by -s/-a) instead of erroring on duplicate. Default ACL
    // (no -A): only /usr/bin/security is trusted, which is all both the GUI and schedmgr need.
    // macOS limitation: /usr/bin/security has no stdin-password option, so the token is briefly
    // visible in the process argument list (`ps`) for the duration of the spawn (typically <100ms).
    // That is a lower risk than a persistent 0600 plaintext file but NOT zero; there is no CLI
    // workaround short of calling the Keychain Services C API directly. (Linux uses stdin — no argv.)
    return { cmd: 'security', args: ['add-generic-password', '-U', '-s', service, '-a', account, '-w', token] }
  }
  if (platform === 'linux') {
    // secret-tool reads the secret from stdin (never argv), so the token stays out of `ps`.
    return { cmd: 'secret-tool', args: ['store', '--label=ChronosUI notify token', 'service', service], stdin: token }
  }
  return null
}

export function readCommand(platform: NodeJS.Platform, service: string): KeychainCommand | null {
  if (platform === 'darwin') return { cmd: 'security', args: ['find-generic-password', '-s', service, '-w'] }
  if (platform === 'linux') return { cmd: 'secret-tool', args: ['lookup', 'service', service] }
  return null
}

export function deleteCommand(platform: NodeJS.Platform, service: string): KeychainCommand | null {
  if (platform === 'darwin') return { cmd: 'security', args: ['delete-generic-password', '-s', service] }
  if (platform === 'linux') return { cmd: 'secret-tool', args: ['clear', 'service', service] }
  return null
}

/** Store the token in the OS keychain. Returns true only if it was actually stored; false on an
 *  unsupported platform, a non-zero exit, or an exec error — so the caller falls back to the file. */
export async function keychainStore(
  exec: ExecFn,
  platform: NodeJS.Platform,
  service: string,
  account: string,
  token: string
): Promise<boolean> {
  const c = writeCommand(platform, service, account, token)
  if (!c) return false
  try {
    const { code } = await exec(c.cmd, c.args, c.stdin)
    return code === 0
  } catch {
    return false
  }
}

/** Read the token from the OS keychain. Returns the trimmed value, or null if absent / unsupported /
 *  errored — so the caller can fall back to the file (mirrors the Go reader's keychain-first logic). */
export async function keychainRead(exec: ExecFn, platform: NodeJS.Platform, service: string): Promise<string | null> {
  const c = readCommand(platform, service)
  if (!c) return null
  try {
    const { code, stdout } = await exec(c.cmd, c.args)
    if (code !== 0) return null
    const v = stdout.trim()
    return v || null
  } catch {
    return null
  }
}

/** Best-effort keychain delete (used when clearing the token). Never throws. */
export async function keychainDelete(exec: ExecFn, platform: NodeJS.Platform, service: string): Promise<void> {
  const c = deleteCommand(platform, service)
  if (!c) return
  try {
    await exec(c.cmd, c.args)
  } catch {
    /* best-effort */
  }
}

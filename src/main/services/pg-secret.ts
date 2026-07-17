// SPDX-License-Identifier: Apache-2.0
//
// Electron-side store/read/delete for a Postgres DSN in the OS keychain — generalizes the
// service-specific storeToken/readToken pattern in notify.service.ts (keychain-first, 0600
// fallback file) to an arbitrary caller-chosen keychain `service` name (a DSN is per-connection,
// e.g. "com.augustusw.chronos-ui/pg-dsn", not the single fixed NOTIFY_TOKEN_SERVICE). Reuses
// notify-keychain.ts's command builders/exec wrappers verbatim (same darwin `security` / linux
// `secret-tool` plumbing already validated by the notify token feature) rather than
// re-implementing keychain shelling here.
//
// Mirrors the Go reader (schedmgr/secret.go resolveDSNWith / readSecretFile): keychain first, then
// a 0600 <sanitizeService(service)>.dsn fallback file. Electron-free + exec injected, so it is
// unit-testable headlessly.

import { mkdirSync, writeFileSync, readFileSync, chmodSync, unlinkSync } from 'node:fs'
import { sep, join } from 'node:path'
import { keychainWriteSupported, keychainStore, keychainRead, keychainDelete, type ExecFn } from './notify-keychain'

/** Keychain account for all pg DSN items (mirrors notify.service.ts's KEYCHAIN_ACCOUNT). The Go
 *  reader (secret_darwin.go / secret_linux.go) matches by service only — the account never needs
 *  to match anything on the read side, it just needs to be stable so `security -U` updates the
 *  existing item in place instead of erroring on a duplicate. */
const KEYCHAIN_ACCOUNT = 'chronos-ui'

/** JS port of schedmgr/secret.go's sanitizeService: strings.NewReplacer("/", "_", ":", "_",
 *  string(os.PathSeparator), "_") — maps a keychain service name (which may contain '/' or ':',
 *  e.g. "com.augustusw.chronos-ui/pg-dsn") to a safe filename for the 0600 fallback file.
 *
 *  Go's os.PathSeparator is a compile-time constant bound to the target OS (each platform ships
 *  its own schedmgr binary). Node's ambient `path.sep` is the runtime-host equivalent (Electron
 *  likewise ships a separate build per OS), so it is used directly here instead of threading a
 *  `platform` param through — unlike goSecretDir in notify-secret.ts, which deliberately takes an
 *  explicit platform so a single test run can simulate all three target OSes' *directory* layout.
 *  sanitizeService has no such need: it is always invoked for "this machine's" fallback file, and
 *  its only cross-platform-relevant test data (Go's TestSanitizeService) never exercises the
 *  separator branch (only '/' and ':', both host-independent). */
export function sanitizeService(service: string): string {
  let out = service.split('/').join('_').split(':').join('_')
  if (sep !== '/') out = out.split(sep).join('_')
  return out
}

/** `<configDir>/<sanitizeService(service)>.dsn` — mirrors Go's readSecretFile:
 *  filepath.Join(dir, sanitizeService(service)+ext). `configDir` MUST already be the app's
 *  chronos-ui config dir (i.e. notify-secret.ts's goSecretDir(...) return value, which already
 *  ends in ".../chronos-ui") — this function does not itself compute or append that segment; it
 *  reuses goSecretDir for that instead of re-deriving the OS config-dir logic here. */
export function pgSecretFallbackPath(configDir: string, service: string): string {
  return join(configDir, `${sanitizeService(service)}.dsn`)
}

export interface PgSecretDeps {
  /** Runs a keychain CLI (security / secret-tool); injected so tests never touch the real keychain. */
  exec: ExecFn
  /** Host platform — selects keychain write support (mirrors the Go reader). */
  platform: NodeJS.Platform
  /** The chronos-ui config dir (e.g. notify-secret.ts's goSecretDir(...) return value) the 0600
   *  fallback file lives under — same contract as pgSecretFallbackPath's `configDir`. */
  configDir: string
}

/** Store a Postgres DSN under `service`: keychain-first (mirroring the Go reader), falling back to
 *  a 0600 file on an unsupported platform or a keychain-write failure. */
export async function pgSecretStore(service: string, dsn: string, deps: PgSecretDeps): Promise<void> {
  if (keychainWriteSupported(deps.platform)) {
    const stored = await keychainStore(deps.exec, deps.platform, service, KEYCHAIN_ACCOUNT, dsn)
    if (stored) return
  }
  const path = pgSecretFallbackPath(deps.configDir, service)
  mkdirSync(deps.configDir, { recursive: true })
  writeFileSync(path, dsn, { mode: 0o600 })
  // Belt-and-braces: writeFileSync's `mode` option only applies when the file is newly created: an
  // overwrite of a pre-existing looser-permission fallback file would otherwise keep those bits.
  chmodSync(path, 0o600)
}

/** Read the DSN for `service`: keychain first, then the 0600 fallback file (trimmed; empty → null),
 *  mirroring resolveSecretWith's keychain-first / fallback-file logic in schedmgr/secret.go. */
export async function pgSecretRead(service: string, deps: PgSecretDeps): Promise<string | null> {
  if (keychainWriteSupported(deps.platform)) {
    const fromKeychain = await keychainRead(deps.exec, deps.platform, service)
    if (fromKeychain) return fromKeychain
  }
  try {
    const v = readFileSync(pgSecretFallbackPath(deps.configDir, service), 'utf8').trim()
    return v || null
  } catch {
    return null
  }
}

/** Best-effort delete of both the keychain item and the fallback file. Never throws. */
export async function pgSecretDelete(service: string, deps: PgSecretDeps): Promise<void> {
  if (keychainWriteSupported(deps.platform)) {
    await keychainDelete(deps.exec, deps.platform, service)
  }
  try {
    unlinkSync(pgSecretFallbackPath(deps.configDir, service))
  } catch {
    /* no fallback file to remove */
  }
}

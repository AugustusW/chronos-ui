// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The active-backend config (spec §4). The DSN is NEVER stored here — it lives only in the OS
 *  keychain (referenced by `pgService`). Lives at `userData/chronos-config.json`. */
export type BackendConfigFile = { backend: 'sqlite' | 'postgres'; pgService?: string }

const DEFAULT: BackendConfigFile = { backend: 'sqlite' }

/** Structural slice of Electron's `app` — keeps this unit-testable without importing electron. */
export interface ConfigApp {
  getPath(name: 'userData'): string
}

function configPath(app: ConfigApp): string {
  return join(app.getPath('userData'), 'chronos-config.json')
}

/** Read the active-backend config; returns the SQLite default when the file is missing/corrupt or
 *  carries an unknown backend value. */
export function readBackendConfig(app: ConfigApp): BackendConfigFile {
  try {
    const raw = JSON.parse(readFileSync(configPath(app), 'utf8')) as Partial<BackendConfigFile>
    if (raw && (raw.backend === 'sqlite' || raw.backend === 'postgres')) {
      return {
        backend: raw.backend,
        pgService: typeof raw.pgService === 'string' ? raw.pgService : undefined
      }
    }
  } catch {
    // missing or corrupt file → safe default
  }
  return { ...DEFAULT }
}

export function writeBackendConfig(app: ConfigApp, cfg: BackendConfigFile): void {
  writeFileSync(configPath(app), JSON.stringify(cfg, null, 2), 'utf8')
}

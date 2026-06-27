// SPDX-License-Identifier: Apache-2.0
import type { BackendConfigFile } from '../db/backendConfig'

/** The non-secret schedmgr DB descriptor baked into cron lines / Task actions. Postgres uses a
 *  `pg:keychain:<service>` reference — schedmgr resolves the DSN from the OS keychain at runtime, so
 *  the secret never touches the crontab (spec §3.3). SQLite uses the plain db file path. */
export function schedmgrDbDescriptor(cfg: BackendConfigFile, sqlitePath: string): string {
  return cfg.backend === 'postgres' && cfg.pgService ? `pg:keychain:${cfg.pgService}` : sqlitePath
}

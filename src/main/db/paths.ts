// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'

/** Structural slice of Electron's `app` — keeps this module unit-testable without importing electron. */
export interface AppPaths {
  getPath(name: 'userData'): string
  isPackaged: boolean
}

export function resolveDbPath(app: AppPaths): string {
  return join(app.getPath('userData'), 'chronos.db')
}

/**
 * Resolve BOTH per-dialect Drizzle migration folders (architect MEDIUM #4). The bundled location
 * differs dev vs packaged: in a packaged build they ship via electron-builder `asarUnpack` under
 * `process.resourcesPath`. The active dialect's folder is picked by `runMigrations`.
 */
export function resolveMigrationsPaths(
  app: AppPaths,
  ctx: { appRoot: string; resourcesPath: string }
): { sqlite: string; pg: string } {
  const base = app.isPackaged
    ? join(ctx.resourcesPath, 'app.asar.unpacked', 'out/main')
    : join(ctx.appRoot, 'out/main')
  return { sqlite: join(base, 'migrations'), pg: join(base, 'migrations.pg') }
}

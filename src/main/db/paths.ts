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
 * Resolve the Drizzle migrations folder (architect MEDIUM #4). `migrate.ts`'s `import.meta.url`
 * default breaks once electron-vite bundles main and packs it into `.asar`. Plan 5 injects this
 * explicitly; Plan 7 finalizes the prod asarUnpack wiring.
 */
export function resolveMigrationsPath(
  app: AppPaths,
  ctx: { appRoot: string; resourcesPath: string }
): string {
  return app.isPackaged
    ? join(ctx.resourcesPath, 'app.asar.unpacked', 'out/main/migrations')
    : join(ctx.appRoot, 'out/main/migrations')
}

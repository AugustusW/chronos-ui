// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path'

export interface SchedmgrPathCtx {
  isPackaged: boolean
  platform: NodeJS.Platform
  appRoot: string // project root in dev (resolved at bootstrap)
  resourcesPath: string // process.resourcesPath in prod
}

/**
 * Injectable seam (design D2). Dev points at the Go-built binary in `schedmgr/`; prod resolves
 * from `resourcesPath`. Plan 7 (packaging) hardens the prod branch (bundle + asarUnpack).
 */
export function resolveSchedmgrPath(ctx: SchedmgrPathCtx): string {
  const bin = ctx.platform === 'win32' ? 'schedmgr.exe' : 'schedmgr'
  const base = ctx.isPackaged ? ctx.resourcesPath : ctx.appRoot
  return join(base, 'schedmgr', bin)
}

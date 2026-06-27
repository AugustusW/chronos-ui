// SPDX-License-Identifier: Apache-2.0
/** Display name of the native scheduler for the given platform.
 *  win32 uses Windows Task Scheduler; mac/linux use crontab. */
export function schedulerLabel(platform: string): string {
  return platform === 'win32' ? 'Task Scheduler' : 'crontab'
}

/** Renderer-safe read of the host platform exposed by preload (`window.chronos.platform`).
 *  Centralizes the one defensive access — falls back to 'darwin' if the bridge isn't present
 *  yet (very early render) or in unit tests that don't stub it. */
export function hostPlatform(): string {
  const w = (globalThis as { window?: { chronos?: { platform?: string } } }).window
  return w?.chronos?.platform ?? 'darwin'
}

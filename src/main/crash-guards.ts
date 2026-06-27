// SPDX-License-Identifier: Apache-2.0

/** Minimal slice of an EventEmitter (process / Electron app) — keeps this unit-testable. */
export interface CrashGuardEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface CrashGuardDeps {
  process: CrashGuardEmitter
  app: CrashGuardEmitter
  /** Structured log sink (defaults to console.error). */
  log?: (message: string, detail: unknown) => void
  /** Surface the error to the user (defaults to no-op; wire to Electron dialog.showErrorBox). */
  showError?: (title: string, content: string) => void
}

/** Render any thrown value into a developer-readable string (prefer the full stack). */
function detailToString(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}

/**
 * Last-resort crash guards for the main process. Without these, a single stray uncaught exception or
 * unhandled rejection anywhere in main tears down the whole app (the "閃退" class of bug).
 *
 * ChronosUI is a developer-facing tool, so these do NOT silently swallow errors: each event is logged
 * AND surfaced to the user via `showError` (a native error dialog with the full message + stack), then
 * the app is kept alive. This turns a hard crash into a visible, debuggable error.
 */
export function installCrashGuards(deps: CrashGuardDeps): void {
  const log = deps.log ?? ((message: string, detail: unknown): void => { console.error(message, detail) })
  const showError = deps.showError ?? ((): void => {})

  // Reentrancy guard: if log/showError themselves throw, the resulting uncaughtException must NOT
  // re-enter report() — that would be an infinite loop (stack overflow). Drop nested reports.
  let reporting = false
  function report(kind: string, detail: unknown): void {
    if (reporting) return
    reporting = true
    try {
      log(`[main] ${kind} — app kept alive`, detail)
      showError(`ChronosUI — ${kind}`, detailToString(detail))
    } finally {
      reporting = false
    }
  }

  deps.process.on('uncaughtException', (err) => report('uncaughtException', err))
  deps.process.on('unhandledRejection', (reason) => report('unhandledRejection', reason))
  // Electron's render-process-gone passes (event, webContents, details); the last arg is the
  // `details` object ({ reason, exitCode }), which detailToString JSON-stringifies for the dialog.
  deps.app.on('render-process-gone', (...args) => report('render-process-gone', args[args.length - 1]))
}

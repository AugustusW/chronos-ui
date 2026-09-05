// SPDX-License-Identifier: Apache-2.0

/**
 * The single place that decides whether the app is allowed to close.
 *
 * Why this exists as a unit rather than a module-level boolean: on win32/linux the main window's
 * `close` handler cancels the close and hides the window instead, so an app that merely calls
 * `app.quit()` tears down its tray, timers and database and then keeps running with no window —
 * a process only Task Manager can end. The flag that suppresses that interception used to be set
 * in exactly one place (the tray's Quit), so every *other* way of quitting was silently broken.
 * macOS never runs the interception, which is why neither the test suite nor a Mac-only manual
 * check would ever catch it.
 *
 * Anything that wants the app to exit calls `requestQuit()`. The close handler asks
 * `shouldInterceptClose()`. Adding a third exit path cannot reintroduce the bug, because there is
 * no flag left to forget to set.
 */
export interface QuitGuard {
  /** Quit for real: mark the intent, then ask Electron to quit. */
  requestQuit(): void
  /** True when a window `close` should be cancelled and the window hidden instead. */
  shouldInterceptClose(): boolean
  /** Test seam: whether requestQuit has been called. */
  readonly quitRequested: boolean
}

export interface QuitGuardDeps {
  /** electron's app.quit. */
  quit: () => void
  /** process.platform — injected so the win32/linux behaviour is testable on a Mac. */
  platform: NodeJS.Platform
}

export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let quitting = false
  return {
    requestQuit() {
      quitting = true
      deps.quit()
    },
    shouldInterceptClose() {
      // macOS keeps the app alive with no windows by convention, and its own close is not a quit —
      // the interception is a win32/linux tray-app behaviour only.
      return !quitting && deps.platform !== 'darwin'
    },
    get quitRequested() {
      return quitting
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
//
// Renderer security hardening helpers. Deliberately free of any `electron` import so the pure pieces
// (the CSP string + the navigation predicate) can be unit-tested headlessly AND imported by
// electron.vite.config.ts at build time. The one wiring function takes an injected webContents-like
// object + an openExternal callback instead of reaching for electron directly.

/**
 * Content-Security-Policy for the packaged renderer. Injected as a <meta http-equiv> at BUILD time
 * (see electron.vite.config.ts) because the renderer loads over file:// in production, where
 * session.webRequest.onHeadersReceived never fires. Kept deliberately tight (code review #2):
 *   - no 'unsafe-eval' anywhere; scripts come only from the app bundle ('self')
 *   - style-src allows 'unsafe-inline' because Vue applies component styles and :style bindings as
 *     inline style tags/attributes at runtime (dropping it breaks the UI); scripts are NOT relaxed
 *   - object / frame / form sinks are closed
 * Not applied in dev — the Vite dev server needs inline + ws: for HMR, so the injector is build-only.
 */
export function buildCspContent(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * True if a navigation target stays within the app itself — the same dev-server origin in dev, or any
 * file:// URL in a packaged build. External navigations are denied so a malicious or stray link cannot
 * repoint the main window away from the app (code review #3).
 */
export function isInternalNavigation(targetUrl: string, appUrl: string): boolean {
  let target: URL
  let app: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  try {
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return target.protocol === 'file:'
  return target.origin === app.origin
}

export interface WindowOpenDetails {
  url: string
}
export type WindowOpenAction = { action: 'deny' } | { action: 'allow' }

/** The slice of Electron's WebContents this module touches (injected so it stays test-friendly). */
export interface WebContentsLike {
  setWindowOpenHandler(handler: (details: WindowOpenDetails) => WindowOpenAction): void
  on(event: 'will-navigate', listener: (e: { preventDefault(): void }, url: string) => void): void
}

/**
 * Lock down navigation on a window's webContents (code review #3):
 *   - window.open / target=_blank never spawn an in-app window; http(s) links open in the OS browser
 *     instead (via the injected openExternal), every other scheme is silently dropped.
 *   - full-page navigations away from the app's own URL are prevented.
 */
export function installNavigationHardening(
  wc: WebContentsLike,
  getAppUrl: () => string,
  openExternal: (url: string) => void
): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (!isInternalNavigation(url, getAppUrl())) e.preventDefault()
  })
}

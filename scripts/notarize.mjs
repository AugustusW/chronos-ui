// SPDX-License-Identifier: Apache-2.0
// electron-builder afterSign hook — notarize the macOS .app via notarytool (ASC API key).
// Credentials come from env (never committed): APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER.
import { notarize } from '@electron/notarize'

export default async function notarizing(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  // Escape hatch for local/dev builds without ASC creds (e.g. verifying the build pipeline
  // before the API key is provisioned). Default path (flag unset) performs real notarization.
  if (process.env.CHRONOS_SKIP_NOTARIZE === '1') {
    console.warn(
      '⚠️  CHRONOS_SKIP_NOTARIZE=1 — skipping notarization; this dmg will NOT be notarized (dev/local only).'
    )
    return
  }
  const appName = ctx.packager.appInfo.productFilename
  await notarize({
    appBundleId: 'com.augustusw.chronos-ui',
    appPath: `${ctx.appOutDir}/${appName}.app`,
    appleApiKey: process.env.APPLE_API_KEY,
    appleApiKeyId: process.env.APPLE_API_KEY_ID,
    appleApiIssuer: process.env.APPLE_API_ISSUER
  })
}

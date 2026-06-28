# Releasing ChronosUI

Each release attaches two installers to the GitHub Release for a tag:

- **macOS** — signed + notarized `.dmg`, built and uploaded **locally** (see below).
- **Windows** — unsigned `.exe` (NSIS), built by CI (`.github/workflows/release.yml`).

Why the split: the Developer ID signing key is **Cloud-managed and cannot be exported** to a
`.p12` for CI, so macOS signing/notarization must happen on a machine that has the key in its
keychain. Windows needs no cert, so CI builds it.

## macOS — local build (signed + notarized)

The signing identity (`Developer ID Application: …`) lives in the login keychain; the App Store
Connect API key for notarization is configured in `~/.config/chronos-ui/notarize.env`
(`APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` — not in any repo).

```bash
# 1. bump version in package.json + commit + tag (see "Cutting a release")
# 2. build, sign, and notarize the .app (electron-builder afterSign hook → notarytool)
source ~/.config/chronos-ui/notarize.env
npm run dist:mac          # → dist/ChronosUI-<ver>-arm64.dmg (the .app inside is stapled)

# 3. notarize + staple the .dmg itself (so the download has no Gatekeeper prompt)
xcrun notarytool submit dist/ChronosUI-*-arm64.dmg \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple dist/ChronosUI-*-arm64.dmg
xcrun stapler validate dist/ChronosUI-*-arm64.dmg   # "The validate action worked!"

# 4. attach to the Release
gh release upload v<ver> dist/ChronosUI-*-arm64.dmg --clobber --repo AugustusW/chronos-ui
```

## Windows — CI build (unsigned)

`release.yml` runs on a `v*` tag push (or **Actions → Release → Run workflow** with the tag) and
uploads `ChronosUI-Setup-<ver>.exe` to the Release. No secrets required.

```bash
gh workflow run release.yml --repo AugustusW/chronos-ui -f tag=v<ver>
```

## Cutting a release

```bash
# bump version in package.json, commit, then:
git tag -a v0.1.2 -m "ChronosUI 0.1.2"
git push origin v0.1.2          # → triggers the Windows CI build
# then run the macOS local-build steps above and `gh release upload` the dmg
```

## Windows SmartScreen

The Windows installer is unsigned, so SmartScreen shows "Windows protected your PC" on first run.
Click **More info → Run anyway**. To remove the warning, add a Windows code-signing cert
(Authenticode) — set `CSC_LINK` / `CSC_KEY_PASSWORD` on the repo and re-add signing to the
Windows job, or use Azure Trusted Signing.

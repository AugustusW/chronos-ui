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

One command does all of it:

```bash
# after bumping the version, committing and tagging (see "Cutting a release")
source ~/.config/chronos-ui/notarize.env
npm run release:mac                 # build, notarize, staple, upload, then verify the release
npm run release:mac -- --no-upload  # stop before touching the GitHub Release
```

`scripts/release-mac.sh` reads the version from `package.json` and always addresses
`dist/ChronosUI-<ver>-arm64.dmg` by name. Do not substitute a glob such as
`dist/ChronosUI-*-arm64.dmg`. `dist/` accumulates across builds, so that pattern also matches
installers from older versions and will notarize or upload the wrong file.

<details>
<summary>The same steps by hand</summary>

```bash
source ~/.config/chronos-ui/notarize.env
VER=$(node -p "require('./package.json').version")

# 1. build, sign, and notarize the .app (electron-builder afterSign hook → notarytool)
npm run dist:mac          # → dist/ChronosUI-$VER-arm64.dmg (the .app inside is stapled)

# 2. notarize + staple the .dmg itself (so the download has no Gatekeeper prompt)
xcrun notarytool submit "dist/ChronosUI-$VER-arm64.dmg" \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "dist/ChronosUI-$VER-arm64.dmg"
xcrun stapler validate "dist/ChronosUI-$VER-arm64.dmg"   # "The validate action worked!"

# 3. attach to the Release
gh release upload "v$VER" "dist/ChronosUI-$VER-arm64.dmg" --clobber --repo AugustusW/chronos-ui
```

</details>

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

# then, on a Mac with the signing key:
source ~/.config/chronos-ui/notarize.env && npm run release:mac
```

Both installers must end up on the Release. See "If the macOS build is forgotten" below.

## If the macOS build is forgotten

`.github/workflows/verify-release-assets.yml` checks, daily and whenever a Release is published or
edited, that the newest release carries both a `.dmg` and an `.exe`, and fails if either is absent.

This is the check v0.4.0 needed. CI was green, the Release existed, the Windows installer was
attached, and the macOS one simply was not, so nothing indicated a problem for 20 days while the
README pointed macOS users at that release. Every automated part had succeeded, which is exactly
why the gap was invisible.

GitHub disables scheduled workflows on a repository with no activity for 60 days. If the check
stops running, re-enable it from the Actions tab.

## Windows SmartScreen

The Windows installer is unsigned, so SmartScreen shows "Windows protected your PC" on first run.
Click **More info → Run anyway**. To remove the warning, add a Windows code-signing cert
(Authenticode) — set `CSC_LINK` / `CSC_KEY_PASSWORD` on the repo and re-add signing to the
Windows job, or use Azure Trusted Signing.

# Releasing ChronosUI

Installers are built and attached to a GitHub Release by `.github/workflows/release.yml`:

- **macOS** → signed + notarized `.dmg` (Developer ID Application + App Store Connect API key)
- **Windows** → unsigned `.exe` (NSIS). No code-signing cert yet, so first launch shows a
  SmartScreen warning — see [Windows note](#windows-smartscreen) below.

## One-time setup: GitHub secrets

Only the macOS job needs secrets. Set them under **Settings → Secrets and variables → Actions**
(or via `gh secret set`). The signing material never lands in the repo.

| Secret | What it is |
|---|---|
| `CSC_LINK` | base64 of the **Developer ID Application** `.p12` |
| `CSC_KEY_PASSWORD` | the password you set when exporting that `.p12` |
| `APPLE_API_KEY_B64` | base64 of the App Store Connect API key `.p8` |
| `APPLE_API_KEY_ID` | the ASC API key ID (e.g. `ABCD1234EF`) |
| `APPLE_API_ISSUER` | the ASC API issuer UUID |

### Export the Developer ID `.p12`

The cert is already in your login keychain (`Developer ID Application: YU CHIN WANG`).

```bash
# Keychain Access → My Certificates → right-click "Developer ID Application: …"
#   → Export → save as devid.p12 → set an export password.
# Then:
base64 -i devid.p12 | pbcopy        # paste as CSC_LINK
#                                     CSC_KEY_PASSWORD = the export password
```

### App Store Connect API key (.p8)

This is the same key `notarize.mjs` already uses locally (`APPLE_API_KEY` / `APPLE_API_KEY_ID`
/ `APPLE_API_ISSUER`). If you need to (re)create it: App Store Connect → Users and Access →
Integrations → App Store Connect API → generate a key with **Developer** access, download the
`.p8` once, and note the Key ID + Issuer ID.

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy   # paste as APPLE_API_KEY_B64
```

### Set them with the gh CLI (alternative to the web UI)

```bash
gh secret set CSC_LINK          --repo AugustusW/chronos-ui < <(base64 -i devid.p12)
gh secret set CSC_KEY_PASSWORD  --repo AugustusW/chronos-ui   # prompts for value
gh secret set APPLE_API_KEY_B64 --repo AugustusW/chronos-ui < <(base64 -i AuthKey_XXXXXXXXXX.p8)
gh secret set APPLE_API_KEY_ID  --repo AugustusW/chronos-ui
gh secret set APPLE_API_ISSUER  --repo AugustusW/chronos-ui
```

## Cutting a release

```bash
# bump version in package.json, commit, then:
git tag -a v0.1.2 -m "ChronosUI 0.1.2"
git push origin v0.1.2          # → triggers the Release workflow
```

For a tag that already exists (e.g. the current `v0.1.1`), trigger it manually:
**Actions → Release → Run workflow** and enter the tag, or:

```bash
gh workflow run release.yml --repo AugustusW/chronos-ui -f tag=v0.1.1
```

The workflow builds on `macos-latest` (arm64) and `windows-latest` (x64) and uploads the
`.dmg` / `.exe` to the Release for that tag.

## Windows SmartScreen

The Windows installer is unsigned, so SmartScreen shows
"Windows protected your PC" on first run. Click **More info → Run anyway**. To remove the
warning later, add a Windows code-signing cert (Authenticode) as `CSC_LINK` / `CSC_KEY_PASSWORD`
for the Windows job, or use Azure Trusted Signing.

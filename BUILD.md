# Building ChronosUI distributables

## macOS (.dmg, signed + notarized) — on the Mac mini

### Prerequisites

- **Node 20.20.2** — the repo's `.nvmrc` pins Node 20; v20.20.2 is the exact installed version.
- **Go 1.25+** — Go 1.26.x is fine.
- **Developer ID Application** certificate in the login keychain (not the App Store "Apple Distribution" cert).
- **App Store Connect API key** for notarization — set these env vars before building (never commit them):

  | Variable | Value |
  |---|---|
  | `APPLE_API_KEY` | Filesystem path to the downloaded `.p8` key file |
  | `APPLE_API_KEY_ID` | The Key ID from App Store Connect |
  | `APPLE_API_ISSUER` | The Issuer ID from App Store Connect |

### Build

Pin the Node 20 PATH first — the default shell may have a newer Node that breaks the
better-sqlite3 native ABI:

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
git clone https://github.com/AugustusW/chronos-ui.git
cd chronos-ui
npm ci
npm run dist:mac
# → dist/ChronosUI-<version>-arm64.dmg  (signed + notarized + stapled)
```

`npm run dist:mac` runs these stages internally:

1. **`stage:schedmgr`** — Go build of the `schedmgr` binary.
2. **`npm run build`** — typecheck + electron-vite build, including copying drizzle migrations.
3. **`electron-builder --mac`** — rebuilds better-sqlite3 for Electron's ABI, asar-unpacks it
   along with the migrations, bundles `schedmgr` into `Resources/schedmgr/`, signs with
   Developer ID, and runs the notarize `afterSign` hook.

### Verify the artifact

```bash
# Confirm the staple is present on the .dmg
xcrun stapler validate dist/ChronosUI-*.dmg

# After dragging to /Applications:
spctl --assess --type execute /Applications/ChronosUI.app
# → should report "accepted"

# Confirm the nested schedmgr binary is signed
codesign -dv "/Applications/ChronosUI.app/Contents/Resources/schedmgr/schedmgr"
```

### Escape hatch — skip notarization for local testing

If you don't have the ASC API key available and only need a local `.dmg` for testing,
set `CHRONOS_SKIP_NOTARIZE=1` before the build:

```bash
CHRONOS_SKIP_NOTARIZE=1 npm run dist:mac
```

This skips notarization with a loud warning. **Do NOT use this artifact for distribution** —
macOS Gatekeeper will block it on other machines.

---

## Windows (.exe NSIS, unsigned) — on the Windows Desktop

> v1 is unsigned. SmartScreen will warn on first run ("Windows protected your PC").
> Click **More info → Run anyway** to proceed. This is expected for v1.

### Prerequisites

Install these before running the build:

1. **Node 20.x** — match the version in `.nvmrc`.
2. **Go** (latest stable).
3. **Visual Studio Build Tools 2022** with the **"Desktop development with C++"** workload.
4. **Python 3.x**.

> VS Build Tools and Python are required by node-gyp if `npm ci` source-compiles
> better-sqlite3 (when no matching prebuild is available for the Electron 34 ABI).
> Install them upfront so the build cannot fail on a missing compiler.

> ⚠️ **Developer Mode / symlink extraction:** electron-builder unpacks its `winCodeSign`
> helper, whose archive contains macOS symlinks. On Windows, extracting symlinks requires
> either **Administrator** privileges or **Developer Mode** enabled. On a non-admin account
> with Developer Mode **off**, the build fails while extracting `winCodeSign`. Fix (either):
> - **Settings → Privacy & security → For developers → Developer Mode = On**, or
> - pre-populate the electron-builder cache so the symlink extraction is skipped
>   (`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\`).

### Build (PowerShell)

```powershell
git clone https://github.com/AugustusW/chronos-ui.git
cd chronos-ui
npm ci          # obtains or rebuilds better-sqlite3 for the Electron 34 ABI
npm run dist:win
# → dist\ChronosUI-Setup-<version>.exe  (unsigned NSIS installer)
```

### Smoke after install

1. **Launch** ChronosUI.
2. The schedule list reads **Windows Task Scheduler** and reconciles existing jobs.
3. Click **Run Now** on a job — output streams in the UI.
4. The **system tray** Open/Quit menu works; closing the window minimizes to tray.
5. Confirm `schedmgr.exe` resolves from `resources\schedmgr\` inside the install directory.

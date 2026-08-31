#!/usr/bin/env bash
#
# Build, notarize, staple and upload the macOS .dmg for the version in package.json.
#
# Why this is a script and not four documented steps: the Developer ID key is Cloud-managed and
# cannot be exported for CI, so macOS is the one artifact a human has to produce. Four steps you
# have to remember is four chances to forget one, and v0.4.0 shipped without a .dmg for 20 days
# because of exactly that. See RELEASING.md.
#
# Usage:
#   source ~/.config/chronos-ui/notarize.env
#   npm run release:mac                # build, notarize, staple, upload to the matching tag
#   npm run release:mac -- --no-upload # everything except the upload
#
set -euo pipefail

REPO="${CHRONOS_RELEASE_REPO:-AugustusW/chronos-ui}"
upload=1
[ "${1:-}" = "--no-upload" ] && upload=0

for var in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  if [ -z "${!var:-}" ]; then
    echo "error: $var is not set. Run 'source ~/.config/chronos-ui/notarize.env' first." >&2
    exit 1
  fi
done

version=$(node -p "require('./package.json').version")
# An explicit filename, never a glob: dist/ is an accumulating directory and still holds .dmg files
# from older versions, so 'ChronosUI-*-arm64.dmg' matches more than the build we just made.
dmg="dist/ChronosUI-${version}-arm64.dmg"

echo "==> Building ${version}"
npm run dist:mac

[ -f "$dmg" ] || { echo "error: expected $dmg, which the build did not produce." >&2; exit 1; }

echo "==> Notarizing $dmg"
xcrun notarytool submit "$dmg" \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait

echo "==> Stapling"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"

if [ "$upload" -eq 0 ]; then
  echo "==> Done (upload skipped). Artifact: $dmg"
  exit 0
fi

echo "==> Uploading to release v${version}"
gh release upload "v${version}" "$dmg" --clobber --repo "$REPO"

echo "==> Verifying the release now carries both installers"
names=$(gh api "repos/${REPO}/releases/tags/v${version}" --jq '.assets[].name')
echo "$names" | sed 's/^/  /'
grep -q '\.dmg$' <<<"$names" || { echo "error: no .dmg on the release after upload." >&2; exit 1; }
grep -q '\.exe$' <<<"$names" || {
  echo "warning: no .exe on the release. The Windows build runs in CI on the tag push;" >&2
  echo "         check Actions, or: gh workflow run release.yml --repo ${REPO} -f tag=v${version}" >&2
}
echo "==> Done."

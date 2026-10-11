#!/bin/bash
# Builds dist/mac-<arch>/CueSign.app and a zip of it.
#
#   scripts/build-mac.sh                 unsigned, for this Mac's own use
#   ARCH=x64 scripts/build-mac.sh        Intel build (default: this Mac's architecture)
#
# To sign and notarize for distribution, set:
#   CODESIGN_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   NOTARY_PROFILE      a keychain profile made once with:
#                       xcrun notarytool store-credentials <name> --apple-id ... --team-id ... --password ...
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${ARCH:-$(uname -m | sed 's/x86_64/x64/')}"
DOTNET="${DOTNET:-$(command -v dotnet || echo "$HOME/.dotnet/dotnet")}"
VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' app/CueSign.App.csproj)"
OUT="dist/mac-$ARCH"
# The bundle is assembled and signed in a temporary folder: cloud-synced folders such as iCloud
# Drive attach extended attributes to files, and codesign refuses to sign anything carrying them.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/CueSign.app"

echo "==> Building the web UI"
(cd web && npm install --silent && npm run build --silent)

echo "==> Publishing CueSign $VERSION for osx-$ARCH"
rm -rf "$OUT"
mkdir -p "$OUT" "$APP/Contents/MacOS" "$APP/Contents/Resources"
"$DOTNET" publish app -c Release -r "osx-$ARCH" --self-contained -p:DebugType=none -o "$APP/Contents/MacOS" --nologo -v quiet

# Data files belong in Resources; only code stays in MacOS, which keeps code signing straightforward.
mv "$APP/Contents/MacOS/wwwroot" "$APP/Contents/MacOS/player" "$APP/Contents/Resources/"
cp app/Assets/CueSign.icns "$APP/Contents/Resources/"
sed "s/@VERSION@/$VERSION/g" app/macos/Info.plist > "$APP/Contents/Info.plist"
xattr -cr "$APP"

if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  echo "==> Signing as $CODESIGN_IDENTITY"
  # Inside out: every file in MacOS first, then the bundle that seals them.
  find "$APP/Contents/MacOS" -type f -print0 | while IFS= read -r -d '' file; do
    codesign --force --timestamp --options runtime --entitlements app/macos/entitlements.plist --sign "$CODESIGN_IDENTITY" "$file"
  done
  codesign --force --timestamp --options runtime --entitlements app/macos/entitlements.plist --sign "$CODESIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"

  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing (this usually takes a few minutes)"
    ditto -c -k --keepParent "$APP" "$STAGE/notarize.zip"
    xcrun notarytool submit "$STAGE/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
  else
    echo "    NOTARY_PROFILE not set: signed but not notarized, so Gatekeeper will still warn on other Macs."
  fi
else
  echo "==> No CODESIGN_IDENTITY: ad-hoc signing for local use only"
  codesign --force --deep --sign - "$APP"
fi

ZIP="$OUT/CueSign-$VERSION-mac-$ARCH.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
ditto "$APP" "$OUT/CueSign.app"
echo "==> Done: $OUT/CueSign.app"
echo "         $ZIP   (share this one: it is the copy whose signature is guaranteed intact)"

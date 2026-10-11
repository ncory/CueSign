#!/bin/bash
# Builds an unsigned Windows copy of CueSign into dist/win-<arch>/CueSign and zips it.
# Runs on macOS, Linux or Windows (Git Bash). ARCH is x64 (default) or arm64.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${ARCH:-x64}"
DOTNET="${DOTNET:-$(command -v dotnet || echo "$HOME/.dotnet/dotnet")}"
VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' app/CueSign.App.csproj)"
OUT="dist/win-$ARCH"

echo "==> Building the web UI"
(cd web && npm install --silent && npm run build --silent)

echo "==> Publishing CueSign $VERSION for win-$ARCH"
rm -rf "$OUT"
# One CueSign.exe holding the runtime and libraries, with the wwwroot and player folders beside it.
"$DOTNET" publish app -c Release -r "win-$ARCH" --self-contained -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none -o "$OUT/CueSign" --nologo -v quiet
rm -f "$OUT/CueSign"/*.pdb # debug symbols for the graphics libraries: large, and not needed to run

ZIP="CueSign-$VERSION-win-$ARCH.zip"
(cd "$OUT" && rm -f "$ZIP" && zip -qr "$ZIP" CueSign)
echo "==> Done: $OUT/CueSign/CueSign.exe"
echo "         $OUT/$ZIP"

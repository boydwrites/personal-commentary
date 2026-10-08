#!/bin/bash
# Builds "Personal Commentary.app" for this checkout and installs it in ~/Applications.
# The app runs the server from this folder with the Node found now, so rebuild if you move the folder or change Node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
DEST="${COMMENTARY_APP_DIR:-$HOME/Applications}/Personal Commentary.app"
WORK="$ROOT/dist/mac"
APP="$WORK/Personal Commentary.app"

major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || { echo "Personal Commentary needs Node 24 or later (found $("$NODE" -v) at $NODE). Run nvm use, then try again." >&2; exit 1; }

cd "$ROOT"
[ -d node_modules ] || npm install
npm run build

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$WORK/cache"
xcrun swiftc -swift-version 5 -parse-as-library -O -module-cache-path "$WORK/cache" \
  -framework AppKit -framework WebKit mac/PersonalCommentary.swift -o "$APP/Contents/MacOS/PersonalCommentary"

rm -rf "$WORK/PersonalCommentary.iconset"
xcrun swift -module-cache-path "$WORK/cache" mac/MakeIcon.swift web/public/mark.svg "$WORK/PersonalCommentary.iconset"
iconutil -c icns "$WORK/PersonalCommentary.iconset" -o "$APP/Contents/Resources/PersonalCommentary.icns"

VERSION="$("$NODE" -p 'require("./package.json").version')"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Personal Commentary</string>
  <key>CFBundleDisplayName</key><string>Personal Commentary</string>
  <key>CFBundleIdentifier</key><string>local.personalcommentary.desktop</string>
  <key>CFBundleExecutable</key><string>PersonalCommentary</string>
  <key>CFBundleIconFile</key><string>PersonalCommentary.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHumanReadableCopyright</key><string>A private study desk. Runs on this Mac only.</string>
  <key>CommentaryRoot</key><string>$ROOT</string>
  <key>CommentaryNode</key><string>$NODE</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
echo "Installed $DEST"
echo "Open it from Spotlight or drag it to the Dock. Quitting it (⌘Q or closing the window) stops the server."

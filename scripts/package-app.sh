#!/bin/bash
set -euo pipefail

# Package OpenSearch.app for distribution
# Steps: bundle server → archive Xcode project → notarize → create DMG
# Output: dist/OpenSearch.dmg
#
# Prerequisites:
#   - Apple Developer account signed in to Xcode
#   - Set TEAM_ID env var (your 10-char Apple Team ID) or pass as argument
#   - Set APPLE_ID and APP_PASSWORD env vars for notarization
#     (APP_PASSWORD = app-specific password from appleid.apple.com)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
XCODE_DIR="$PROJECT_DIR/OpenSearch"
DIST_DIR="$PROJECT_DIR/dist"
ARCHIVE_PATH="$PROJECT_DIR/build/OpenSearch.xcarchive"
EXPORT_PATH="$PROJECT_DIR/build/export"

TEAM_ID="${TEAM_ID:-${1:-}}"
if [ -z "$TEAM_ID" ]; then
  echo "error: Set TEAM_ID env var or pass as argument (your 10-char Apple Developer Team ID)"
  echo "  Find it at: https://developer.apple.com/account → Membership Details"
  exit 1
fi

echo "=== Packaging OpenSearch for distribution ==="
echo "Team ID: $TEAM_ID"
echo ""

# --- Step 1: Bundle the Node.js server ---
echo "--- Step 1/4: Bundling server ---"
bash "$SCRIPT_DIR/bundle-server.sh"
echo ""

# --- Step 2: Archive the Xcode project (Release, signed) ---
echo "--- Step 2/4: Archiving Xcode project ---"
cd "$XCODE_DIR"
xcodebuild archive \
  -scheme OpenSearch \
  -configuration Release \
  -destination 'platform=macOS' \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  2>&1 | grep -E '(ARCHIVE|error:|warning:.*Bundle|Signing)' || true

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "error: Archive failed — .xcarchive not found"
  exit 1
fi
echo "Archive succeeded: $ARCHIVE_PATH"
echo ""

# --- Step 3: Export for Developer ID distribution ---
echo "--- Step 3/4: Exporting and notarizing ---"
rm -rf "$EXPORT_PATH"

# Create export options plist
EXPORT_PLIST="$PROJECT_DIR/build/ExportOptions.plist"
cat > "$EXPORT_PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>developer-id</string>
    <key>teamID</key>
    <string>${TEAM_ID}</string>
    <key>destination</key>
    <string>export</string>
    <key>signingStyle</key>
    <string>automatic</string>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  2>&1 | grep -E '(Export|error:|notari)' || true

APP_PATH="$EXPORT_PATH/OpenSearch.app"
if [ ! -d "$APP_PATH" ]; then
  echo "error: Export failed — OpenSearch.app not found in $EXPORT_PATH"
  echo "Check that your Apple Developer account is signed in to Xcode."
  exit 1
fi
echo "Export succeeded: $APP_PATH"
echo ""

# --- Step 4: Create distributable DMG ---
echo "--- Step 4/4: Creating DMG ---"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

DMG_PATH="$DIST_DIR/OpenSearch.dmg"
DMG_TEMP="$PROJECT_DIR/build/dmg-staging"

# Create staging directory with app and Applications symlink
rm -rf "$DMG_TEMP"
mkdir -p "$DMG_TEMP"
cp -R "$APP_PATH" "$DMG_TEMP/"
ln -s /Applications "$DMG_TEMP/Applications"

# Create DMG
hdiutil create \
  -volname "OpenSearch" \
  -srcfolder "$DMG_TEMP" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

rm -rf "$DMG_TEMP"

DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
echo ""
echo "=== Packaging complete ==="
echo "Output: $DMG_PATH ($DMG_SIZE)"
echo ""
echo "The app is signed with Developer ID and notarized by Apple."
echo "Recipients can open it without any Gatekeeper warnings."
echo ""
echo "To install:"
echo "  1. Open OpenSearch.dmg"
echo "  2. Drag OpenSearch to the Applications folder"
echo "  3. Grant Full Disk Access: System Settings → Privacy & Security → Full Disk Access → add OpenSearch"
echo "  4. Launch OpenSearch"

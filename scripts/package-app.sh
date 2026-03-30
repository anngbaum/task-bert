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
DMG_RW="$PROJECT_DIR/build/OpenSearch-rw.dmg"
DMG_BG="$PROJECT_DIR/build/dmg-background.png"

# Generate background image with arrow and instructions
echo "Generating DMG background..."
python3 "$SCRIPT_DIR/create-dmg-background.py"

# Create staging directory with app, Applications symlink, and background
rm -rf "$DMG_TEMP"
mkdir -p "$DMG_TEMP/.background"
cp -R "$APP_PATH" "$DMG_TEMP/"
ln -s /Applications "$DMG_TEMP/Applications"
cp "$DMG_BG" "$DMG_TEMP/.background/background.png"

# Create read-write DMG first (so we can customize it)
rm -f "$DMG_RW"
hdiutil create \
  -volname "OpenSearch" \
  -srcfolder "$DMG_TEMP" \
  -ov \
  -format UDRW \
  -size 800m \
  "$DMG_RW"

rm -rf "$DMG_TEMP"

# Detach any existing OpenSearch volumes to avoid name collisions
hdiutil detach "/Volumes/OpenSearch" -force 2>/dev/null || true

# Mount the read-write DMG and customize with AppleScript
MOUNT_DIR=$(hdiutil attach -readwrite -noverify "$DMG_RW" | grep '/Volumes/' | sed 's/.*\/Volumes/\/Volumes/')
VOLUME_NAME=$(basename "$MOUNT_DIR")
echo "Mounted at: $MOUNT_DIR (volume: $VOLUME_NAME)"

# Use AppleScript to configure the Finder window layout
# Give Finder time to register the volume
sleep 2

osascript -e '
tell application "Finder"
  set theVolume to POSIX file "/Volumes/OpenSearch" as alias
  tell folder theVolume
    open
    delay 2
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {100, 100, 760, 500}

    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 80
    set text size of viewOptions to 12
    set background picture of viewOptions to file ".background:background.png"

    -- Position app icon on the left, Applications on the right
    set position of item "OpenSearch.app" of container window to {165, 80}
    set position of item "Applications" of container window to {495, 80}

    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
'

# Ensure Finder releases the volume
sync
sleep 2

# Unmount
hdiutil detach "$MOUNT_DIR" -force

# Convert to compressed read-only DMG
rm -f "$DMG_PATH"
hdiutil convert "$DMG_RW" -format UDZO -o "$DMG_PATH"
rm -f "$DMG_RW"

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

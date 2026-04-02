#!/bin/bash
set -euo pipefail

# Package Bert.app for distribution
# Steps: bundle server → archive Xcode project → notarize → create DMG
# Output: website/Bert.dmg
#
# Prerequisites:
#   - Apple Developer account signed in to Xcode
#   - Set TEAM_ID env var (your 10-char Apple Team ID) or pass as argument
#   - Set APPLE_ID and APP_PASSWORD env vars for notarization
#     (APP_PASSWORD = app-specific password from appleid.apple.com)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
XCODE_DIR="$PROJECT_DIR/Bert"
DIST_DIR="$PROJECT_DIR/website"
ARCHIVE_PATH="$PROJECT_DIR/build/Bert.xcarchive"
EXPORT_PATH="$PROJECT_DIR/build/export"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

TEAM_ID="${TEAM_ID:-${1:-}}"
if [ -z "$TEAM_ID" ]; then
  echo "error: Set TEAM_ID in .env or pass as argument (your 10-char Apple Developer Team ID)"
  echo "  Find it at: https://developer.apple.com/account → Membership Details"
  exit 1
fi

if [ -z "${APPLE_ID:-}" ] || [ -z "${APP_PASSWORD:-}" ]; then
  echo "error: APPLE_ID and APP_PASSWORD must be set (in .env or environment)"
  echo "  APPLE_ID = your Apple Developer email"
  echo "  APP_PASSWORD = app-specific password from https://appleid.apple.com"
  exit 1
fi

# Auto-detect Developer ID signing identity from keychain
SIGNING_IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/')
if [ -z "$SIGNING_IDENTITY" ]; then
  echo "error: No 'Developer ID Application' certificate found in keychain"
  echo "  Install one via Xcode → Settings → Accounts → Manage Certificates"
  exit 1
fi

echo "=== Packaging Bert for distribution ==="
echo "Team ID: $TEAM_ID"
echo "Apple ID: $APPLE_ID"
echo "Signing identity: $SIGNING_IDENTITY"
echo ""

# --- Step 1: Bundle the Node.js server ---
echo "--- Step 1/4: Bundling server ---"
bash "$SCRIPT_DIR/bundle-server.sh"
echo ""

# --- Step 2: Archive the Xcode project (Release, signed) ---
echo "--- Step 2/4: Archiving Xcode project ---"
rm -rf "$ARCHIVE_PATH"
cd "$XCODE_DIR"
xcodebuild archive \
  -scheme Bert \
  -configuration Release \
  -destination 'platform=macOS' \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  ENABLE_HARDENED_RUNTIME=YES \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
  CODE_SIGN_ENTITLEMENTS="$XCODE_DIR/Bert/Bert.entitlements" \
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

APP_PATH="$EXPORT_PATH/Bert.app"
if [ ! -d "$APP_PATH" ]; then
  echo "error: Export failed — Bert.app not found in $EXPORT_PATH"
  echo "Check that your Apple Developer account is signed in to Xcode."
  exit 1
fi
echo "Export succeeded: $APP_PATH"

# Sign embedded server binaries with hardened runtime inside the exported app
echo "Signing embedded server binaries..."
ENTITLEMENTS="$XCODE_DIR/Bert/Bert.entitlements"
APP_SERVER_DIR="$APP_PATH/Contents/Resources/server"

# Sign native .node addons first (innermost binaries first)
find "$APP_SERVER_DIR" -name "*.node" -print0 | while IFS= read -r -d '' addon; do
  echo "  Signing addon: $(basename "$addon")"
  codesign --sign "$SIGNING_IDENTITY" --options runtime --timestamp --force --entitlements "$ENTITLEMENTS" "$addon"
done

# Sign the node binary
codesign --sign "$SIGNING_IDENTITY" --options runtime --timestamp --force --entitlements "$ENTITLEMENTS" "$APP_SERVER_DIR/node"
echo "Embedded binaries signed."

# Re-sign the entire app to update the seal after modifying embedded binaries
echo "Re-signing app bundle..."
codesign --sign "$SIGNING_IDENTITY" --options runtime --timestamp --force --entitlements "$ENTITLEMENTS" --deep "$APP_PATH"

# Verify the app is properly signed
echo "Verifying app signature..."
codesign --verify --deep --strict "$APP_PATH"
echo "App signature valid."

# Submit app for notarization
echo "Submitting app for notarization..."
ditto -c -k --keepParent "$APP_PATH" "$PROJECT_DIR/build/Bert-app.zip"
NOTARY_OUTPUT=$(xcrun notarytool submit "$PROJECT_DIR/build/Bert-app.zip" \
  --apple-id "$APPLE_ID" \
  --password "$APP_PASSWORD" \
  --team-id "$TEAM_ID" \
  --wait 2>&1)
echo "$NOTARY_OUTPUT"

# Check if notarization was accepted
if ! echo "$NOTARY_OUTPUT" | grep -q "status: Accepted"; then
  SUBMISSION_ID=$(echo "$NOTARY_OUTPUT" | grep "id:" | head -1 | awk '{print $2}')
  echo "error: Notarization failed. Fetching log..."
  xcrun notarytool log "$SUBMISSION_ID" \
    --apple-id "$APPLE_ID" \
    --password "$APP_PASSWORD" \
    --team-id "$TEAM_ID" 2>&1 || true
  exit 1
fi

# Retry stapling — Apple's CDN can take a moment to propagate the ticket
echo "Stapling notarization ticket..."
for i in 1 2 3 4 5; do
  if xcrun stapler staple "$APP_PATH" 2>&1; then
    break
  fi
  if [ "$i" -eq 5 ]; then
    echo "error: Stapling failed after 5 attempts"
    exit 1
  fi
  echo "  Staple attempt $i failed, retrying in 15s..."
  sleep 15
done

rm -f "$PROJECT_DIR/build/Bert-app.zip"
echo "App notarization complete."
echo ""

# --- Step 4: Create distributable DMG ---
echo "--- Step 4/4: Creating DMG ---"
mkdir -p "$DIST_DIR"

DMG_PATH="$DIST_DIR/Bert.dmg"
DMG_TEMP="$PROJECT_DIR/build/dmg-staging"
DMG_RW="$PROJECT_DIR/build/Bert-rw.dmg"
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
  -volname "Bert" \
  -srcfolder "$DMG_TEMP" \
  -ov \
  -format UDRW \
  -size 800m \
  "$DMG_RW"

rm -rf "$DMG_TEMP"

# Detach any existing Bert volumes to avoid name collisions
hdiutil detach "/Volumes/Bert" -force 2>/dev/null || true

# Mount the read-write DMG and customize with AppleScript
MOUNT_DIR=$(hdiutil attach -readwrite -noverify "$DMG_RW" | grep '/Volumes/' | sed 's/.*\/Volumes/\/Volumes/')
VOLUME_NAME=$(basename "$MOUNT_DIR")
echo "Mounted at: $MOUNT_DIR (volume: $VOLUME_NAME)"

# Use AppleScript to configure the Finder window layout
# Give Finder time to register the volume
sleep 2

osascript -e '
tell application "Finder"
  set theVolume to POSIX file "/Volumes/Bert" as alias
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
    set position of item "Bert.app" of container window to {165, 80}
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

# Sign the DMG
echo "Signing DMG..."
codesign --sign "$SIGNING_IDENTITY" "$DMG_PATH"
codesign --verify "$DMG_PATH"
echo "DMG signature valid."

# Notarize the DMG
echo "Submitting DMG for notarization..."
DMG_NOTARY_OUTPUT=$(xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APP_PASSWORD" \
  --team-id "$TEAM_ID" \
  --wait 2>&1)
echo "$DMG_NOTARY_OUTPUT"

if ! echo "$DMG_NOTARY_OUTPUT" | grep -q "status: Accepted"; then
  echo "error: DMG notarization failed."
  exit 1
fi

echo "Stapling DMG..."
for i in 1 2 3 4 5; do
  if xcrun stapler staple "$DMG_PATH" 2>&1; then
    break
  fi
  if [ "$i" -eq 5 ]; then
    echo "error: DMG stapling failed after 5 attempts"
    exit 1
  fi
  echo "  Staple attempt $i failed, retrying in 15s..."
  sleep 15
done
echo "DMG notarization complete."

DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
echo ""
echo "=== Packaging complete ==="
echo "Output: $DMG_PATH ($DMG_SIZE)"
echo ""
echo "The app and DMG are both signed with Developer ID and notarized by Apple."
echo "Recipients can open it without any Gatekeeper warnings."
echo ""
echo "To install:"
echo "  1. Open Bert.dmg"
echo "  2. Drag Bert to the Applications folder"
echo "  3. Launch Bert"
echo "  4. Grant Full Disk Access: System Settings → Privacy & Security → Full Disk Access → add Bert"
echo "  5. Quit and Reopen Bert"

# --- Upload to GitHub Releases ---
echo ""
echo "--- Uploading to GitHub Releases ---"

# Get version from Xcode project or use date-based tag
VERSION="v$(date +%Y.%m.%d)"

# Delete existing release with this tag if it exists, then create fresh
gh release delete "$VERSION" --repo anngbaum/task-bert -y 2>/dev/null || true
gh release create "$VERSION" "$DMG_PATH" \
  --repo anngbaum/task-bert \
  --title "Bert $VERSION" \
  --notes "Bert for Mac — $DMG_SIZE" \
  --latest

echo "Release uploaded: https://github.com/anngbaum/task-bert/releases/tag/$VERSION"

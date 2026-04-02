#!/bin/bash
set -euo pipefail

# Bundle the Node.js server for embedding inside Bert.app
# Output: build/server/ directory ready to copy into app Resources

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build/server"
NODE_VERSION="20.18.1"

# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  NODE_ARCH="arm64"
elif [ "$ARCH" = "x86_64" ]; then
  NODE_ARCH="x64"
else
  echo "Unsupported architecture: $ARCH"
  exit 1
fi

NODE_DIST="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"

echo "=== Bundling server for macOS ($ARCH) ==="

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# --- Step 1: Download Node.js binary if not cached ---
CACHE_DIR="$PROJECT_DIR/build/.cache"
mkdir -p "$CACHE_DIR"
NODE_TARBALL="$CACHE_DIR/${NODE_DIST}.tar.gz"

if [ ! -f "$CACHE_DIR/$NODE_DIST/bin/node" ]; then
  echo "Downloading Node.js v${NODE_VERSION} (${NODE_ARCH})..."
  curl -fsSL "$NODE_URL" -o "$NODE_TARBALL"
  tar -xzf "$NODE_TARBALL" -C "$CACHE_DIR"
  rm -f "$NODE_TARBALL"
fi

cp "$CACHE_DIR/$NODE_DIST/bin/node" "$BUILD_DIR/node"
chmod +x "$BUILD_DIR/node"
echo "Node binary: $(du -h "$BUILD_DIR/node" | cut -f1)"

# --- Step 2: Compile TypeScript ---
echo "Compiling TypeScript..."
cd "$PROJECT_DIR"
npx tsc --outDir "$BUILD_DIR/dist"

# Copy schema.sql alongside compiled db code (import.meta.dirname reference)
cp "$PROJECT_DIR/src/db/schema.sql" "$BUILD_DIR/dist/db/schema.sql"

# --- Step 3: Install production dependencies ---
echo "Installing production dependencies..."
cp "$PROJECT_DIR/package.json" "$BUILD_DIR/package.json"
cp "$PROJECT_DIR/package-lock.json" "$BUILD_DIR/package-lock.json" 2>/dev/null || true

cd "$BUILD_DIR"
npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# Rebuild native addons with the bundled node
echo "Rebuilding native addons..."
npm rebuild better-sqlite3

# --- Step 4: Prune node_modules ---
echo "Pruning node_modules..."
# Remove typescript source, docs, tests, etc.
find "$BUILD_DIR/node_modules" -type d -name "test" -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR/node_modules" -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR/node_modules" -type d -name "docs" -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR/node_modules" -type d -name ".github" -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR/node_modules" -name "*.ts" ! -name "*.d.ts" -delete 2>/dev/null || true
find "$BUILD_DIR/node_modules" -name "*.map" -delete 2>/dev/null || true
find "$BUILD_DIR/node_modules" -name "*.md" -delete 2>/dev/null || true
find "$BUILD_DIR/node_modules" -name "CHANGELOG*" -delete 2>/dev/null || true
find "$BUILD_DIR/node_modules" -name "LICENSE*" -delete 2>/dev/null || true

# Remove the package.json/lock from the build dir (only needed for npm install)
rm -f "$BUILD_DIR/package-lock.json"

# --- Done ---
BUNDLE_SIZE=$(du -sh "$BUILD_DIR" | cut -f1)
echo ""
echo "=== Server bundle ready ==="
echo "Location: $BUILD_DIR"
echo "Size: $BUNDLE_SIZE"
echo ""
echo "Contents:"
echo "  node          - Node.js runtime"
echo "  dist/         - Compiled server code"
echo "  node_modules/ - Production dependencies"
echo "  package.json  - Package manifest"

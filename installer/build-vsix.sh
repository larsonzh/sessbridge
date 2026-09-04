#!/bin/sh
# Build the SessionBridge .vsix package using Microsoft's vsce (via npx).
# Requires Node.js 16+ available on PATH; fetches vsce on demand.
#
# Usage: sh installer/build-vsix.sh
# Output: dist/sessbridge-<version>.vsix

set -u

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
EXT_DIR="$REPO_ROOT/extension"
DIST_DIR="$REPO_ROOT/dist"
PKG_PATH="$EXT_DIR/package.json"

if [ ! -f "$PKG_PATH" ]; then
    echo "package.json missing in $EXT_DIR" >&2
    exit 1
fi

version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PKG_PATH" | head -n 1)
if [ -z "$version" ]; then
    echo "Cannot extract version from $PKG_PATH" >&2
    exit 1
fi

mkdir -p "$DIST_DIR"
OUT="$DIST_DIR/sessbridge-$version.vsix"

if ! command -v npx >/dev/null 2>&1; then
    echo "npx not found — install Node.js 16+ and retry." >&2
    exit 1
fi

npx --yes @vscode/vsce --version >/dev/null 2>&1 || {
    echo "Cannot fetch @vscode/vsce via npx (network?). Install vsce manually." >&2
    exit 1
}

# shellcheck disable=SC2164
cd "$EXT_DIR" || exit 1
npx --yes @vscode/vsce package --skip-license --out "$OUT" || exit 1
cd "$REPO_ROOT" || exit 1

echo "Built: $OUT"
echo "Next: sh tools/make_checksums.sh -Dir dist"
exit 0

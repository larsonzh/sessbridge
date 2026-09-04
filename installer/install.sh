#!/bin/sh
# SessionBridge extension installer (Linux / macOS / other POSIX systems).
# Mirrors installer/install.ps1 behavior for Windows.
#
# Usage:
#   sh installer/install.sh [--force] [--dir <extensions-dir>]
# Env:
#   VSCODE_EXTENSIONS_DIR  overrides the extensions directory
#                          (default: ~/.vscode/extensions)
#
# Exit codes: 0 = ok/already installed, 1 = source/target error, 3 = bad args.

set -u

SCRIPT_DIR=$(dirname "$0")
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SRC_DIR="$REPO_ROOT/extension"

EXT_DIR="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"
FORCE=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --force) FORCE=1 ;;
        --dir) shift; EXT_DIR="$1" ;;
        -h|--help)
            echo "Usage: $0 [--force] [--dir <extensions-dir>]"
            echo "Env:   VSCODE_EXTENSIONS_DIR  (default: \$HOME/.vscode/extensions)"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 3
            ;;
    esac
    shift
done

TARGET="$EXT_DIR/larsonzh.sessbridge"

if [ -f "$SRC_DIR/package.json" ]; then
    :
else
    echo "package.json missing in $SRC_DIR" >&2
    exit 1
fi

if [ -f "$SRC_DIR/extension.js" ]; then
    :
else
    echo "extension.js missing in $SRC_DIR" >&2
    exit 1
fi

if [ -e "$TARGET" ]; then
    if [ "$FORCE" -ne 1 ]; then
        echo "Extension already installed at $TARGET"
        echo "Use --force to overwrite, or run installer/uninstall.sh first."
        exit 0
    fi
    rm -rf "$TARGET"
fi

if ! mkdir -p "$TARGET"; then
    echo "Cannot create $TARGET" >&2
    exit 1
fi

if ! cp -R "$SRC_DIR"/. "$TARGET"/; then
    echo "Copy failed: $SRC_DIR -> $TARGET" >&2
    exit 1
fi

echo "SessionBridge extension installed to $TARGET"
echo "Reload VS Code (Command Palette -> Developer: Reload Window) to activate."
echo "Verify with: code --list-extensions | grep sessbridge"
exit 0

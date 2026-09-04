#!/bin/sh
# Remove the legacy whois 'vscode-chat-sender' extension (POSIX).
# SessionBridge also speaks the legacy dialect; keep only one extension
# installed to avoid them racing on legacy IPC files.
#
# Usage:
#   sh installer/uninstall-legacy.sh [--dir <extensions-dir>]
# Env:
#   VSCODE_EXTENSIONS_DIR  overrides the extensions directory
#                          (default: ~/.vscode/extensions)

set -u

EXT_DIR="${VSCODE_EXTENSIONS_DIR:-$HOME/.vscode/extensions}"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --dir) shift; EXT_DIR="$1" ;;
        -h|--help)
            echo "Usage: $0 [--dir <extensions-dir>]"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 3
            ;;
    esac
    shift
done

TARGET="$EXT_DIR/larsonzh.vscode-chat-sender"

if [ ! -e "$TARGET" ]; then
    echo "Legacy extension not found at $TARGET"
    exit 0
fi

rm -rf "$TARGET"
echo "Legacy extension removed from $TARGET"
echo "Reload VS Code to complete the removal."
exit 0

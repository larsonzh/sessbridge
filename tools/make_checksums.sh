#!/bin/sh
# Generate a SHA256 checksum manifest (SHA256SUMS) for release artifacts.
# Usage: sh tools/make_checksums.sh [dir]   (default: ./dist)
# Format: "<sha256>  <filename>" sorted by name; excludes SHA256SUMS itself.

set -u

TARGET_DIR="${1:-dist}"

if [ ! -d "$TARGET_DIR" ]; then
    mkdir -p "$TARGET_DIR" || { echo "Cannot create $TARGET_DIR" >&2; exit 1; }
    echo "Created $TARGET_DIR (no artifacts yet)"
fi

if command -v sha256sum >/dev/null 2>&1; then
    HASHER="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    HASHER="shasum -a 256"
else
    echo "No sha256sum/shasum found on PATH" >&2
    exit 1
fi

SUMS="$TARGET_DIR/SHA256SUMS"
: > "$SUMS"

# Enumerate with find (not ls) so shellcheck SC2012 stays clean and odd
# filenames are handled; dist artifacts are plain ASCII names anyway.
find "$TARGET_DIR" -maxdepth 1 -type f -print | LC_ALL=C sort | while IFS= read -r path; do
    name=$(basename "$path")
    [ "$name" = "SHA256SUMS" ] && continue
    # Hash from inside the directory so the emitted filename is bare.
    # Strip the optional '*' binary-mode marker so output is "hash  name".
    (cd "$TARGET_DIR" && $HASHER "$name") | awk '{if (substr($2,1,1)=="*") $2=substr($2,2); print $1"  "$2}' >> "$SUMS"
done

cat "$SUMS"
echo "Wrote $SUMS"
exit 0

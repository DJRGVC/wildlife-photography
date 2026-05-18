#!/usr/bin/env bash
# Copy photos from a source directory (e.g. a camera SD card) into
# src/photography/<section>/, stripping GPS data on the way in.
#
# Usage:
#   ./scripts/import-photos.sh <source_dir> [section] [pattern]
#
# Defaults:
#   section = wildlife
#   pattern = *.JPG
#
# Examples:
#   ./scripts/import-photos.sh /Volumes/EOS_DIGITAL/DCIM/100EOSR7
#   ./scripts/import-photos.sh ~/Pictures/raw-dump misc '*.JPG'
#
# Wildlife-ethics note: GPS coordinates are stripped on import. Originals on
# the source are not modified — only the copies in src/photography/<section>/.

set -euo pipefail

if ! command -v exiftool >/dev/null 2>&1; then
  echo "error: exiftool not found. Install with: brew install exiftool" >&2
  exit 1
fi

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <source_dir> [section=wildlife] [pattern=*.JPG]" >&2
  exit 1
fi

SRC="$1"
SECTION="${2:-wildlife}"
PATTERN="${3:-*.JPG}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src/photography/${SECTION}"

if [ ! -d "$SRC" ]; then
  echo "error: source $SRC is not a directory" >&2
  exit 1
fi

case "$SECTION" in
  wildlife|misc) ;;
  *)
    echo "error: section must be 'wildlife' or 'misc', got: $SECTION" >&2
    exit 1
    ;;
esac

mkdir -p "$DEST"

matched=()
while IFS= read -r -d '' f; do
  matched+=("$f")
done < <(find "$SRC" -type f -iname "$PATTERN" -print0)

if [ "${#matched[@]}" -eq 0 ]; then
  echo "no files matching $PATTERN found in $SRC"
  exit 0
fi

echo "copying ${#matched[@]} photo(s) -> $DEST"
for f in "${matched[@]}"; do
  cp -n "$f" "$DEST/"
done

echo "stripping GPS data from copies (wildlife-ethics)"
exiftool -overwrite_original -gps:all= -location:all= "$DEST"/*.[Jj][Pp][Gg] 2>/dev/null || true
exiftool -overwrite_original -gps:all= -location:all= "$DEST"/*.[Jj][Pp][Ee][Gg] 2>/dev/null || true

echo "done. Run \`npm run dev\` to watch + regenerate image-data.json."

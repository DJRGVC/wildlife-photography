#!/usr/bin/env bash
# Tag a photo's IPTC metadata for the site.
#
# Usage:
#   ./scripts/tag-photo.sh <file.jpg> <animal> <location> [keywords] [caption]
#
# Example:
#   ./scripts/tag-photo.sh src/photography/IMG_0123.jpg \
#     "Great Horned Owl" \
#     "Point Reyes National Seashore" \
#     "owl,raptor,point-reyes" \
#     "Roosting at dusk on a coastal pine."
#
# Writes IPTC:Headline, IPTC:City, IPTC:Keywords, IPTC:Caption-Abstract.
# Requires exiftool (`brew install exiftool`).

set -euo pipefail

if ! command -v exiftool >/dev/null 2>&1; then
  echo "error: exiftool not found. Install with: brew install exiftool" >&2
  exit 1
fi

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <file.jpg> <animal> <location> [keywords,csv] [caption]" >&2
  exit 1
fi

FILE="$1"
ANIMAL="$2"
LOCATION="$3"
KEYWORDS="${4:-}"
CAPTION="${5:-}"

if [ ! -f "$FILE" ]; then
  echo "error: $FILE not found" >&2
  exit 1
fi

ARGS=(
  "-overwrite_original"
  "-IPTC:Headline=$ANIMAL"
  "-IPTC:City=$LOCATION"
  "-XMP:Location=$LOCATION"
)

if [ -n "$KEYWORDS" ]; then
  ARGS+=("-IPTC:Keywords=")
  IFS=',' read -ra KW_ARR <<< "$KEYWORDS"
  for kw in "${KW_ARR[@]}"; do
    kw_trimmed="$(echo "$kw" | sed 's/^ *//;s/ *$//')"
    [ -n "$kw_trimmed" ] && ARGS+=("-IPTC:Keywords+=$kw_trimmed")
  done
fi

if [ -n "$CAPTION" ]; then
  ARGS+=("-IPTC:Caption-Abstract=$CAPTION")
fi

exiftool "${ARGS[@]}" "$FILE"
echo "tagged: $FILE"

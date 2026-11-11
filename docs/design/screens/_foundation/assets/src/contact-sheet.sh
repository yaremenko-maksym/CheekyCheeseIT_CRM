#!/usr/bin/env bash
# Builds one contact sheet per frame set: ../<set>-v2/_contact-sheet.png (labelled tiles, quantised ≤ ~400 KB).
# Usage: ./contact-sheet.sh shell|primitives
set -euo pipefail
set_name="$1"
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/../${set_name}-v2"
font="${CONTACT_FONT:-/System/Library/Fonts/Supplemental/Arial.ttf}"
out="$dir/_contact-sheet.png"
frames=()
while IFS= read -r f; do frames+=("$f"); done < <(find "$dir" -maxdepth 1 -name '*.png' ! -name '_contact-sheet.png' | sort)
[ "${#frames[@]}" -gt 0 ] || { echo "no frames in $dir" >&2; exit 1; }
magick montage -font "$font" -pointsize 13 -fill '#d0d0d0' -label '%t' "${frames[@]}" \
  -tile 6x -geometry 300x400+10+10 -background '#141414' "$out"
magick "$out" -strip -dither None -colors 256 -define png:compression-level=9 "PNG8:$out"
echo "$out $(($(stat -f%z "$out") / 1024)) KB from ${#frames[@]} frames"

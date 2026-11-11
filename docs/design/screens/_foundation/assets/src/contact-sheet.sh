#!/usr/bin/env bash
# Builds the contact sheets of a frame set in ../<set>-v2/ (labelled tiles, each quantised ≤ ~400 KB):
#   _contact-sheet.png         phones (-320 / -375), 6 per row
#   _contact-sheet-wide.png    tablet, desktop and board frames, 3 per row at 620 px
#   _contact-sheet-detail.png  chart-desktop and transition-storyboard at native size (dense frames)
# Usage: ./contact-sheet.sh shell|primitives
set -euo pipefail
set_name="$1"
here="$(cd "$(dirname "$0")" && pwd)"
dir="$here/../${set_name}-v2"
font="${CONTACT_FONT:-/System/Library/Fonts/Supplemental/Arial.ttf}"
phones=()
wide=()
detail=()
while IFS= read -r f; do
  case "$(basename "$f" .png)" in
    *-320 | *-375) phones+=("$f") ;;
    chart-desktop | transition-storyboard) detail+=("$f") ;;
    *) wide+=("$f") ;;
  esac
done < <(find "$dir" -maxdepth 1 -name '*.png' ! -name '_contact-sheet*.png' | sort)
total=$((${#phones[@]} + ${#wide[@]} + ${#detail[@]}))
[ "$total" -gt 0 ] || { echo "no frames in $dir" >&2; exit 1; }

# sheet <out> <pointsize> <tile> <geometry> <frames...>
sheet() {
  local out="$dir/$1"
  magick montage -font "$font" -pointsize "$2" -fill '#d0d0d0' -label '%t' -background '#141414' \
    "${@:5}" -tile "$3" -geometry "$4" "$out"
  magick "$out" -strip -dither None -colors 256 -define png:compression-level=9 "PNG8:$out"
  echo "$out $(($(stat -f%z "$out") / 1024)) KB from $(($# - 4)) frames"
}
rm -f "$dir"/_contact-sheet*.png
[ "${#phones[@]}" -eq 0 ] || sheet _contact-sheet.png 13 6x 300x400+10+10 "${phones[@]}"
[ "${#wide[@]}" -eq 0 ] || sheet _contact-sheet-wide.png 15 3x '620x465>+11+11' "${wide[@]}"
[ "${#detail[@]}" -eq 0 ] || sheet _contact-sheet-detail.png 18 1x '+12+12' "${detail[@]}"

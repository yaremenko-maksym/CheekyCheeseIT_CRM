# CC Monogram Smirk — design notes

## Concept
Two interlocking Cs (CheekyCheeseIT → CC). One large open C, a smaller darker C nested inside its mouth — yin-yang-like rotation. On second glance, the composition reveals a smirk and a wink.

## How the wink/smirk works
- **Smirk**: the lower terminal of the **outer C** does not just end — it hooks upward and forward into a small tongue/curl. Read from a distance it's a confident half-smile pulled to the right. This is the "moment of recognition" gesture.
- **Wink**: a small tilted oval ("the eye") sits above the **inner C**'s upper terminal at ~-15deg. Combined with the smirk it reads as a wink, but it's small and restrained — never emoji.
- **Lean**: the whole composition rotates -5deg (forward italic lean). That's the "cheeky" attitude baked into posture, not decoration.
- **Cheese hole**: a single small dark punch on the outer C body (left side). One. Restraint. Hints at cheese without making the icon a wedge of Swiss.

## Color strategy
- **Dark variant (`icon.svg`)**: outer C in primary `#FFC300`, inner C in deeper `#D9A300` for nested depth. Wink dot is bright yellow; cheese-hole punch is the background `#141414`.
- **Light variant (`icon-light.svg`)**: inversion — outer C in `#D9A300` (holds weight on light), inner C in `#FFC300`. Wink dot in dark amber `#3A2F0E` so it doesn't disappear on the warm off-white. Subtle shadow uses `#3A2F0E` @ 35%.
- All hex codes are exact brand values — no approximations, no gradients.

## Geometric system
- 512×512 canvas, ~96px rounded corner (≈ the 10px UI radius scaled).
- Outer C stroke: 64px. Inner C stroke: 38px. Ratio ~1.68 keeps the inner C visually subordinate but still legible.
- Butt linecaps + explicit squared terminal caps — geometric, not soft. Counterweight to the curling smirk.
- Inner C horizontally inset so the upper-right negative space (between the two Cs) leaves room for the wink dot.

## What gets dropped at 32×32 (`icon-32.svg`)
At favicon scale these details collapse into mush, so they are removed:
- Smirk curl (becomes a yellow blob).
- Wink dot (becomes a single pixel of noise).
- Cheese-hole punch (disappears or muddies the stroke).
- Tone shadow under the outer C.

**Kept**: the two interlocking Cs, the -5deg lean, the dark/light yellow split between outer and inner C. The silhouette is still recognizable as the brand — just without the second-glance moment.

## Why this is not generic
- Letterforms are drawn as custom paths, not system fonts. The outer C has a curling tail; the inner C has hard squared terminals. They don't match any typeface.
- The smirk lives in the **letter geometry itself**, not as a separate emoji-style mouth.
- Two-tone yellow on yellow (primary + muted amber) gives nested depth without resorting to gradients or 3D effects.
- No badge/border. No corporate ring. Just the two Cs and a single dark punch.

## Files
- `icon.svg` — 512×512, dark background, full detail.
- `icon-light.svg` — 512×512, light background variant.
- `icon-32.svg` — 32×32 favicon, simplified silhouette.

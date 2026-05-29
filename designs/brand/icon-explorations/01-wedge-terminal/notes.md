# Wedge Terminal — design notes

## The metaphor

A confident cheese wedge silhouette (apex top-left, base bottom) whose "holes"
double as a terminal prompt. Two readings collide:

1. **Cheese wedge** — the literal yellow slice. "Say cheese", warmth, food, play.
2. **Terminal prompt** — squint and the holes resolve into `>_`:
   - Three circular holes form a downward chevron (the `>`)
   - A rounded-rect block sits to the right (the `_` / blinking cursor)
   - Two extra holes scattered off-axis keep the cheese reading honest

You never see literal text. The terminal is suggested, not stated — which keeps
the icon from feeling like a wordmark and lets the wedge breathe.

## Why this works for CheekyCheeseIT

- **Cheeky** — a triangular slice with eye-like dark dots has personality
  without resorting to a face.
- **Cheese** — instantly legible silhouette. Yellow + wedge = cheese, full stop.
- **IT** — the chevron-of-dots reads as a CLI prompt to anyone who's spent time
  in a terminal; for everyone else it just looks like cheese holes. Two audiences
  served by the same shapes.
- **Senior-led, production-first** — the geometry is restrained. No swooshes,
  no gradients-for-the-sake-of-gradients, no faces. The shadow band along the
  base gives mass and signals "this was designed, not generated".

## Geometry

- 512×512 viewBox, designed on a 16-unit grid.
- Wedge anchor points (before corner rounding):
  - Apex (top-left):       (96, 112)
  - Top-right shoulder:    (432, 224)
  - Bottom-right:          (432, 416)
  - Bottom-left:           (96, 416)
- Corner rounding: 18px tangent arcs (matches the CRM's `--radius` system).
- Holes occupy a safe zone roughly (170-400, 200-400), well clear of edges.

## Color usage

| Token              | Where                              |
|--------------------|------------------------------------|
| `#FFC300`          | Wedge mid-tone (gradient anchor)   |
| `#FFD23A`          | Wedge top-left lift                |
| `#D9A300`          | Wedge bottom-right depth           |
| `#FFE685` @ 0.55   | Apex shine highlight               |
| `#3A2F0E` @ 0.35-0.6 | Hole rims, base shadow band      |
| `#0d1117`          | Hole fill (terminal black)         |
| `#141414`          | Implicit (canvas it lives on)      |

Light variant swaps the primary fill to `#D9A300` and adds a 3px `#3A2F0E`
contour at 0.5 opacity — keeps the silhouette punchy on cream/white surfaces
where pure `#FFC300` would wash out.

## Scaling

- **1024px+** — gradients, highlights, and hole rims all read; full personality.
- **512px (canonical)** — every element does its job; primary deliverable.
- **128-256px** — gradients soften but the chevron + cursor block remain crisp.
- **32px (favicon)** — separate file. Drops to 3 holes (2 chevron dots + cursor block),
  no gradients, integer-snapped coordinates, no outline.
- **16px** — the 32px version still degrades acceptably; you read "yellow wedge
  with dark marks" which is enough at that size.

## Quirks / intentional choices

- The cursor block is a rounded **rectangle**, not a circle. This is the single
  most important micro-decision: it's what tips the holes from "cheese pattern"
  toward "terminal prompt". Without it the icon is just a cheese wedge.
- Holes have a faint warm inner highlight (`#FFE685` at ~30% opacity) on the
  upper-left of each — implies the cheese has depth, the holes are tunnels, not
  flat discs. Removes the "vector clipart" feel.
- The base-shadow gradient is asymmetric (heavier bottom-right) to imply a
  single light source from the upper-left. Consistent across all elements.
- No text, no fonts, no external references — fully self-contained.

## Files

- `icon.svg` — 512×512, dark-bg variant (the canonical mark)
- `icon-light.svg` — 512×512, tuned for light backgrounds
- `icon-32.svg` — simplified favicon

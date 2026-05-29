# 05 — Stacked Layers

## Tilt vs. side-elevation
**Side-elevation (front-facing).** No isometric tilt.

Rationale: isometric would push the mark toward pancake-stack / hamburger-icon territory and add a playful tilt the brief explicitly warns against. Pure side-elevation reads as architectural drawing / CAD section — calmer, more "senior engineer", more Notion/Vercel-adjacent. Depth is conveyed through gradient + thin top-edge highlight on each slab, not through perspective.

## Slab count
**4 slabs.** Reason: 3 reads as podium / iOS app icon; 5+ becomes visual noise at small sizes. 4 maps cleanly to the implied "tech stack" reading (presentation / application / data / infra) and gives each of the three brand yellows + the deepest shadow tone its own dedicated plane.

The 32×32 favicon drops to 3 slabs — at that size the fourth slab compresses to a 4-5px sliver and loses semantic weight. 3 slabs preserve the silhouette.

## Color stack logic
The stack is read from **top → down** as bright → dim, mirroring how a layered tech diagram is usually drawn (UI on top, infra at the bottom):

| Layer | Fill | Brand role |
|---|---|---|
| 1 (top, narrowest) | `#FFC300` → `#FFCE1F` gradient | Primary yellow — the headline. Holds the single cheese-hole signature. |
| 2 (upper-mid) | `#D9A300` → `#E2AC0A` gradient | Yellow muted — supporting tone. |
| 3 (lower-mid) | `#8E6A05` → `#A87E07` gradient | Bridge tone between muted yellow and deep shadow. Not in the official palette but mathematically interpolated between `#D9A300` and `#3A2F0E` so the descent reads continuous, not blotchy. |
| 4 (base, widest) | `#3A2F0E` → `#4A3D14` gradient | Yellow subtle / deepest shadow — foundation. |

Slab widths also descend in the opposite direction: base widest (376px), top narrowest (308px). The result is a gently splayed deck — base feels grounded, top feels precise. Each slab is offset inward ~8–14px from the one below it, intentionally NOT centered-stacked, so it never reads as concentric rings.

## Restraint moves
- **One cheese hole, top slab only.** Cheese reference is delivered once, then the mark gets out of its own way. Lower slabs are clean planes — they're "stack layers", not cheese slices.
- **No outlines on the dark variant** — slabs sit on `#141414` and the gradient + thin top-edge highlight do all the depth work. The light variant adds a 2px `#141414` contour because the top slab would otherwise dissolve into white.
- **Top-edge highlight** (3px lighter strip at the top of each slab) is the only "3D" trick — it reads as the lit edge of an extruded plane without committing to a perspective view.
- **Grounding ellipse shadow** under the stack — anchors the mark, prevents it from floating.

## Geometry
- ViewBox: `0 0 512 512`.
- Slab height: 56. Rounded corners: 14 — tight enough to feel CAD-precise, soft enough to avoid corporate-rectangle stiffness.
- All coordinates are integers. No sub-pixel hinting needed.
- Vertical rhythm: slab tops at y = 146 / 218 / 290 / 362 (72px stride). Bottoms terminate at y = 418. Visual centerline of the stack sits ~y=282, slightly below geometric center of the 512 viewBox — leaves room for the grounding shadow at y=446 without crowding the canvas edge.

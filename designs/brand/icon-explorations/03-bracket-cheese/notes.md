# 03 — Bracket Cheese

## Bracket choice: angle brackets `< >`

Picked angle over `{ }` and `[ ]` for three reasons:

1. **Implicit wedge silhouette.** A `<` arm naturally points to a wedge tip — same shape as a slice of cheese seen from the side. The brackets do double duty: code grammar + cheese geometry, without forcing either reading.
2. **Strongest "web" association.** `< >` carries HTML/JSX/Markup energy. For an outsource shop whose biggest visible deliverable is web product (EdTech, E-Commerce), that's the right tribal signal. `{ }` would lean too generic-backend; `[ ]` would feel arrays-and-data, not product.
3. **Best center void.** Angle brackets open up the widest negative gap in the middle of the mark, giving room for the cursor / "I of IT" bar without crowding.

## Geometry — not the typographic glyph

The brackets are custom polygons, not a chunky `<` from a typeface:

- **Outer hull** runs top → tip → bottom (standard chevron outline).
- **Inner edge** is a parallel offset of the outer, so the arm has uniform stroke weight (≈70px at the apex) and a **flat inner face** the cheese holes can sit on cleanly.
- **Tip angle** is wider than a standard glyph `<` (~110° vs. typographic 60°) — gives the mark more shoulder and stops the silhouette reading as a "less-than sign in a box".
- **Notched inner corners** where the inside edge meets the tip line. That subtle chamfer is what makes it feel chiseled/forged rather than vector-default.

## Hole arrangement logic — 3-2-1 hierarchy

Each bracket carries **3 holes** following a size hierarchy:

| Bracket | Hole sizes (radius) | Logic |
|---|---|---|
| Left  | 22, 14, 9 px  | One anchor hole, one supporting, one tiny |
| Right | 26, 18, 11 px | Same rhythm, mirrored — the largest hole is on the *opposite* arm from the left's largest |

Why not symmetric? Because perfectly mirrored holes would feel decorative/stamped. The opposing-anchor placement makes the eye dance diagonally across the mark — the holes feel **drilled by hand**, which is the playful "cheeky" part. The sizes follow a roughly geometric ratio (~1.6x) — close to golden, eyeballed for visual weight rather than math-exact.

Placement constraints:
- Every hole sits on the **inner arm** of its bracket so it never breaks the outer silhouette — at small sizes the mark stays a clean chevron pair.
- No hole comes closer than ~15px to a tip — the chevron points must read as sharp.

## The center cursor / "I"

A vertical pill bar between the brackets does triple duty:
- **Text cursor** (blinking between `< >`),
- **Letter I** for IT,
- **Symmetry anchor** — the mark is otherwise asymmetric (offset hole sizes), so the cursor locks the composition vertically.

A single tiny hole in the cursor (4px) keeps the cheese motif consistent across all three elements of the mark — left bracket, cursor, right bracket — instead of being a yellow bar that fights the cheese reading.

## Color strategy

| Layer | Color | Role |
|---|---|---|
| Bracket body | `#FFC300 → #D9A300` linear gradient | Cheese highlight to shadow, gives volume |
| Bevel overlay | `#3A2F0E` at 0→55% opacity | Warm-amber depth at the bottom edge — chisel feel |
| Holes (dark variant) | `#141414` punched through via mask | True negative space → strongest cheese effect |
| Holes (light variant) | `#3A2F0E` painted in | Deep amber pockets; punching to `#F7F7F7` would erase cheese metaphor |

No domain accent color (violet/emerald/orange). The mark is service-agnostic — accents belong on marketing surfaces, not the primary mark.

## Legibility at scale

- **1024px** — bevel and 6 holes register clearly, mark feels detailed.
- **512px** — all detail intact, target canvas.
- **128px** — bevel softens but reads as warmth, holes still distinct.
- **32px (favicon)** — simplified to 2 holes total + no bevel + no inner notch. The chevron pair + cursor silhouette carries the brand at this size.

## What this mark is NOT

- Not a `<>` typed in Source Code Pro on a card.
- Not a terminal screenshot.
- Not a code-editor aesthetic with line numbers.
- Not a generic dev-mark with a purple gradient.

The "ah it's cheese inside brackets" insight has to land in the first two seconds — that's the test. The holes are non-negotiable and load-bearing; without them this is just brackets.

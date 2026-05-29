# Cursor Wedge — Brand Mark

## The collision

A terminal block-cursor and a wedge of cheese share more geometry than you'd think:
both are tall, both have weight, both want a single confident silhouette. The mark
leans into that overlap: it is unmistakably a CLI cursor (rounded rectangle, top
heavy, sits as if mid-blink), but the right edge is sliced on a ~12 degrees angle and the
body carries scattered round holes — and suddenly it's cheese.

Nothing on the icon is *only* one or the other. The slant could be a wedge cut or
a stylized italic cursor. The holes could be cheese eyes or terminal status dots.
That ambiguity is the joke, and it lands because both readings are flattering to
the brand: senior-led discipline (the cursor) and playful warmth (the cheese).

## What's doing the work

- **Split-tone fill** (`#FFC300` top, `#D9A300` bottom): not decoration — it sells
  the *blinking* afterimage. The eye reads a half-faded cursor caught between
  states, which is the brand's existing Hero animation crystallized into a static
  shape. The `<animate>` opacity pulse (1.1s, indefinite) makes it literal when
  the SVG is used as an animated avatar; the static export still reads as blink
  because of the tone split.
- **The 12 degrees slant** on the right edge does the cheese-wedge work without
  resorting to a triangle. A triangle would lose the cursor; a pure rectangle
  would lose the cheese. The slant is small enough to keep the cursor identity
  dominant and large enough to never read as a rectangle.
- **Three holes, asymmetric**: a grid of holes would look like Swiss-cartoon
  cheese (corporate, mascot territory). Asymmetric scatter — one large upper-left,
  one medium lower-right near the cut edge, one tiny — feels like a real wedge
  and like terminal status indicators at the same time.
- **One hole tinted violet (`#a78bfa`, 18% alpha)**: the only domain-accent in
  the mark. Nods to the Hero's rotating cursor color (AI/EdTech/E-Comm) without
  picking sides. Easy to swap per-context if needed.
- **Halo at 8–12% alpha**: warmth, not glow. Keeps the icon from sitting flat on
  `#141414`.

## What survives at 32×32

- The wedge silhouette (slanted right edge, rounded corners).
- Two holes (down from four — three is the readable minimum at favicon scale;
  the file ships with two for safety margin).
- The dark bottom band for cursor-weight.

What gets dropped: the split-tone gradient (banding artifacts), the halo, the
accent-tinted hole, the top highlight. None of those are load-bearing for
recognition — they're polish. At 32×32 the mark is a flat amber wedge with two
dark eyes, and it still reads.

## What this mark refuses to do

- No terminal chrome (macOS dots, prompt characters, text). The chrome belongs
  in the Hero animation; the mark is the cursor itself, not a screenshot of one.
- No mascot. No eyes, no smile, no character. The wedge is the character.
- No gradient blob, no purple-cyan AI-slop aesthetic, no centered-glowing-orb.
- No literal cheese rendering (no triangular wedge with a single cartoon hole).
  The mark is a cursor first and cheese second; reverse that and it becomes a
  food brand.

## Files

- `icon.svg` — 512×512 dark-first master. Includes optional blink animation.
- `icon-light.svg` — same geometry, tuned for light backgrounds (outlined rim,
  deeper hole shading, no halo since white bg already provides separation).
- `icon-32.svg` — simplified favicon. Flat fill, two holes, no gradients.

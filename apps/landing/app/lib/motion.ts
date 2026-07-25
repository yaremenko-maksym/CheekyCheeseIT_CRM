/**
 * Motion-token module (docs/design/landing-redesign.md §M.0) — the single
 * source of truth for every JS-driven (Framer Motion `useTransform`/
 * `animate()`) duration/easing value on the landing. Existing CSS
 * Tailwind-transition durations (hover/press on buttons/cards/chips, §M.2)
 * stay inline as Tailwind `duration-*`/`ease-out` classes — they are NOT
 * re-homed here, see the module doc in landing-redesign.md §M.0 for why.
 */

/**
 * Signature easing curve (§5.1 `Reveal`) — reserved for scroll-POSITION-
 * driven §M.1 effects (`ScrollReveal`'s own 3-point `useTransform` curve
 * embodies this shape directly; it isn't consumed as a literal `ease:`
 * param anywhere, since `useTransform` interpolates against scroll
 * progress, not time). NOT used for any time-based (duration+ease) JS
 * animation — see `EASE_SOFT` below for those.
 */
export const EASE_STANDARD = [0.2, 0.6, 0.2, 1] as const

/**
 * HOTFIX 2026-07-24 (owner: page-transition "very fast, hits the eyes,
 * epilepsy risk for some — make sure ALL animations are smooth"): the
 * single default easing for EVERY time-based (duration+ease) JS animation
 * on the landing — page-transition (§M.3), smooth-scroll (§M.4). Symmetric
 * easeInOutCubic: soft start AND soft finish, no jerk on start, no hard
 * stop. Replaces the removed `EASE_EXIT` (was `[0.4,0,1,1]`, a hard
 * "full-speed" finish — part of the "too fast" complaint) as the light
 * page-transition's easing too.
 */
export const EASE_SOFT = [0.65, 0, 0.35, 1] as const

export const DUR_REVEAL = 0.7 // section scroll-reveal (unchanged)

/** In-page anchor smooth-scroll (§M.4) — duration unchanged, easing switches to `EASE_SOFT`. */
export const DUR_SMOOTH_SCROLL = 0.6

// §M v3 (2026-07-25) — REPLACES DUR_SCRIM_IN/DUR_SCRIM_OUT/DUR_CARET_SWEEP/
// DUR_LIGHT_TRANSITION (the scrim + thin caret-line page-transition, §M.3,
// was removed entirely — owner: "contrasts with the site's overall lighting
// and hits the eyes"). Replaced by a "soft lift" cross-fade applied to EVERY
// page transition, plus a separate shared-element title morph on
// `/careers ↔ /careers/:slug` — see docs/design/landing-redesign.md §M v3.0.
// EASE_SOFT above remains the single default for every time-based JS
// animation below too — no separate easing curve is introduced for lift/morph.
/** Old page fades + settles down (§M v3.1) — 220ms. */
export const DUR_LIFT_EXIT = 0.22
/** New page fades + rises into place (§M v3.1) — 300ms. */
export const DUR_LIFT_ENTER = 0.3
/** `translateY` 0 → +10 (down) on exit, px. */
export const LIFT_OFFSET_EXIT = 10
/** `|translateY|` on enter, px — sign depends on navigation direction (§M v3.1). */
export const LIFT_OFFSET_ENTER = 14
/** Shared-element title morph duration, `/careers ↔ /careers/:slug` (§M v3.2) — 350ms. */
export const DUR_TITLE_MORPH = 0.35

/**
 * Hover/press durations (CSS Tailwind-transitions on buttons/cards/chips,
 * §M.2) stay inline as Tailwind `duration-*` classes, NOT tokens here — but
 * HOTFIX 2026-07-24 requires an explicit `ease-out` Tailwind class
 * (`cubic-bezier(0,0,0.2,1)`, strictly decelerating) on every one of them,
 * replacing the implicit Tailwind default (`cubic-bezier(0.4,0,0.2,1)`,
 * which has a slight acceleration before decelerating) — every hover
 * duration is also confirmed ≥150ms (owner: "hover ≥150ms"); the one value
 * that sat exactly on that boundary (`Input`/`Textarea`, 150ms) is raised
 * to 180ms with margin. `duration-200`/`duration-300` classes are already
 * consistent between `button.tsx`/`card.tsx`/`chip.tsx`/`vacancy-card.tsx`;
 * §M.2 names the duration class per element, without inventing a parallel
 * system for something already uniform.
 */

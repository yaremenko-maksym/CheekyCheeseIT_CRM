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

// HOTFIX 2026-07-24 — page-transition duration UP (owner: "up, aim for
// 350-500ms"), plus renamed for the new dark-scrim + thin caret-line
// mechanic (§M.3) — this is no longer a solid full-screen "wipe" fill:
/** Dark scrim fades in (was `DUR_WIPE_IN` = 0.2, a solid yellow fill). */
export const DUR_SCRIM_IN = 0.23
/** Scrim fades out (was `DUR_WIPE_OUT` = 0.26) — total scrim lifecycle = 500ms, top of the owner's 350-500ms range. */
export const DUR_SCRIM_OUT = 0.27
/** Thin yellow leading edge sweeps across the screen ONCE — longer than the scrim phases so it doesn't read as a "flash". */
export const DUR_CARET_SWEEP = 0.42
/** Page-transition lightweight back/forward variant (was 0.18 — also part of the "too fast" complaint). */
export const DUR_LIGHT_TRANSITION = 0.26

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

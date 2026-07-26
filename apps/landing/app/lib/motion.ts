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
 * HOTFIX 2026-07-24 (owner: the since-removed page-transition "very fast,
 * hits the eyes, epilepsy risk for some — make sure ALL animations are
 * smooth"): the single default easing for EVERY time-based (duration+ease)
 * JS animation on the landing — smooth-scroll (§M.4) is the only remaining
 * consumer (task-landing-remove-page-transitions.md removed the page-
 * transition, §M v3.1/§M v3.2, that used to share this curve too — see
 * docs/design/landing-redesign.md §M v3 "SUPERSEDED"). Symmetric
 * easeInOutCubic: soft start AND soft finish, no jerk on start, no hard
 * stop.
 */
export const EASE_SOFT = [0.65, 0, 0.35, 1] as const

export const DUR_REVEAL = 0.7 // section scroll-reveal (unchanged)

/** In-page anchor smooth-scroll (§M.4) — duration unchanged, easing switches to `EASE_SOFT`. */
export const DUR_SMOOTH_SCROLL = 0.6

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

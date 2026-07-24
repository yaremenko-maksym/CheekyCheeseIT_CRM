/**
 * Motion-token module (docs/design/landing-redesign.md §M.0) — the single
 * source of truth for every JS-driven (Framer Motion `useTransform`/
 * `animate()`) duration/easing value on the landing. Existing CSS
 * Tailwind-transition durations (hover/press on buttons/cards/chips, §M.2)
 * stay inline as Tailwind `duration-*` classes — they are NOT re-homed here,
 * see the module doc in landing-redesign.md §M.0 for why.
 */

/** Signature easing curve (§5.1 `Reveal`) — reused by every scroll-linked/page-transition/smooth-scroll effect below so nothing feels like a different animation "language". */
export const EASE_STANDARD = [0.2, 0.6, 0.2, 1] as const

/** Shorter/quieter curve for "disappearances" (make-interfaces-feel-better: exit should read faster than enter). */
export const EASE_EXIT = [0.4, 0, 1, 1] as const

/** Section scroll-reveal (`ScrollReveal`, §M.1) — unchanged from the original one-shot `Reveal`. */
export const DUR_REVEAL = 0.7

/** In-page anchor smooth-scroll (§M.4). */
export const DUR_SMOOTH_SCROLL = 0.6

/** Page-transition: the yellow bar sweeping IN to cover the screen (§M.3). */
export const DUR_WIPE_IN = 0.2

/** Page-transition: the yellow bar sweeping OUT to reveal the new page (§M.3). */
export const DUR_WIPE_OUT = 0.26

/** Page-transition: the lightweight back/forward crossfade variant (§M.3). */
export const DUR_LIGHT_TRANSITION = 0.18

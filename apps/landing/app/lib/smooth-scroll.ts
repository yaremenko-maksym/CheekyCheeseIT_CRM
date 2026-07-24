import { animate } from 'framer-motion'
import { DUR_SMOOTH_SCROLL, EASE_STANDARD } from './motion'

/**
 * `nav.tsx`'s sticky header height (`h-[66px]`) + breathing room — every
 * anchor target needs this much extra scroll so the header doesn't cover it
 * (§M.4 point 2).
 */
const HEADER_OFFSET = 66 + 16

/**
 * JS-driven in-page smooth scroll to an anchor id (§M.4) — owns the
 * "hash-link on the same page" case exclusively (see `nav.tsx`/`footer.tsx`
 * callers). Uses the shared `EASE_STANDARD` curve instead of the browser's
 * un-customizable native smooth-scroll easing, and explicitly bypasses the
 * animation entirely under `prefers-reduced-motion: reduce` — checked via
 * `matchMedia` (not `useReducedMotion()`) because this module runs outside
 * any component's render, so a React hook isn't available here.
 */
export function smoothScrollToId(id: string): void {
  const el = document.getElementById(id)
  if (!el) return
  const targetY = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo(0, targetY)
    return
  }
  animate(window.scrollY, targetY, {
    duration: DUR_SMOOTH_SCROLL,
    ease: EASE_STANDARD,
    onUpdate: (v) => window.scrollTo(0, v),
  })
}

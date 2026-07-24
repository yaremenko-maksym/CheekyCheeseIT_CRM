import { animate, type AnimationPlaybackControls } from 'framer-motion'
import { DUR_SMOOTH_SCROLL, EASE_STANDARD } from './motion'

/**
 * `nav.tsx`'s sticky header height (`h-[66px]`) + breathing room — every
 * anchor target needs this much extra scroll so the header doesn't cover it
 * (§M.4 point 2). Also mirrored as the `scroll-mt-[82px]` Tailwind class on
 * every hash-anchor `<section>` in `routes/index.tsx` — that CSS-level copy
 * covers the router's OWN native (non-JS) `scrollIntoView` landing for a
 * CROSS-page hash link (`hashScrollIntoView` stays default `true` there,
 * see `lib/hash-link-props.ts`'s module doc); this JS constant covers the
 * SAME-page case this module owns. Keep both in sync if the header height
 * ever changes.
 */
const HEADER_OFFSET = 66 + 16

/**
 * Module-level handle for the in-flight scroll animation (if any) — same
 * "mutable state outside the React tree" pattern as `wipe-transition.ts`.
 * There is only ever one smooth-scroll happening at a time (it drives the
 * single `window.scrollY`), so a shared singleton is enough.
 */
let activeScroll: AnimationPlaybackControls | null = null
let activeScrollCleanup: (() => void) | null = null

/**
 * Halts any in-flight smooth-scroll immediately and removes its user-gesture
 * listeners. Called both by a repeat `smoothScrollToId()` call (rapid
 * double-click on a different nav link must not leave two animations both
 * driving `window.scrollTo` every frame) and by the wheel/touchstart
 * listener below (a real scroll gesture from the visitor means they want
 * manual control back immediately, not a fight against the animation).
 */
function cancelActiveScroll(): void {
  activeScroll?.stop()
  activeScroll = null
  activeScrollCleanup?.()
  activeScrollCleanup = null
}

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
  // A repeat call — e.g. rapid double-click on a different nav link before
  // the first scroll finishes — must not leave two animations racing on
  // window.scrollTo.
  cancelActiveScroll()

  const el = document.getElementById(id)
  if (!el) return
  const targetY = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo(0, targetY)
    return
  }

  const controls = animate(window.scrollY, targetY, {
    duration: DUR_SMOOTH_SCROLL,
    ease: EASE_STANDARD,
    onUpdate: (v) => window.scrollTo(0, v),
  })
  activeScroll = controls

  // A real user scroll gesture (wheel or touch) during the animation means
  // the visitor wants manual control back — stop immediately instead of
  // fighting their input every frame. `once: true` removes each listener
  // after it fires; `cleanup` below also removes both if the animation
  // finishes naturally first (no gesture happened), so a stale listener
  // never lingers waiting for a gesture that's no longer relevant.
  const onUserScrollIntent = () => cancelActiveScroll()
  window.addEventListener('wheel', onUserScrollIntent, { once: true, passive: true })
  window.addEventListener('touchstart', onUserScrollIntent, { once: true, passive: true })
  activeScrollCleanup = () => {
    window.removeEventListener('wheel', onUserScrollIntent)
    window.removeEventListener('touchstart', onUserScrollIntent)
  }

  void controls.then(
    () => {
      // Finished naturally (not interrupted) — clear our handle/listeners so
      // they don't outlive this run. Guarded by identity in case a NEWER
      // call already replaced `activeScroll` by the time this settles.
      if (activeScroll === controls) {
        activeScroll = null
        activeScrollCleanup?.()
        activeScrollCleanup = null
      }
    },
    () => {
      // Interrupted via `.stop()` — `cancelActiveScroll()` already cleared
      // everything at the call site that triggered the interruption.
    },
  )
}

import { animate } from 'framer-motion'
import { DUR_LIFT_EXIT, EASE_SOFT, LIFT_OFFSET_EXIT } from './motion'

/**
 * Plays the exit half of the lift cross-fade (docs/design/landing-
 * redesign.md §M v3.1 step 4) on the currently-mounted content wrapper —
 * fire-and-forget, imperative, NOT awaited by the caller (the router isn't
 * blocked on it; see the module doc's "принятый компромисс" on `__root.tsx`
 * for why an occasional mid-flight interruption is an accepted trade-off,
 * not a bug).
 *
 * A no-op when `el` is `null` (nothing mounted yet — e.g. the very first
 * navigation subscription fires before any wrapper ref has been attached,
 * though in practice `onBeforeNavigate` never fires that early) or when
 * `reducedMotion` is `true` (the old page just disappears instantly on
 * unmount, §M v3.1 "Reduced-motion").
 */
export function playLiftExit(el: HTMLElement | null, reducedMotion: boolean): void {
  if (!el || reducedMotion) return
  void animate(
    el,
    { opacity: [1, 0], y: [0, LIFT_OFFSET_EXIT] },
    { duration: DUR_LIFT_EXIT, ease: EASE_SOFT },
  )
}

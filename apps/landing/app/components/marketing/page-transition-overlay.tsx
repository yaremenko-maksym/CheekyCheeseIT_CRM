import { forwardRef, useImperativeHandle, useRef } from 'react'

/**
 * Handle exposed to `__root.tsx`'s orchestrator — the DOM nodes of both
 * layers, so `lib/scrim-transition.ts` can drive them imperatively via
 * framer-motion's standalone `animate()`.
 */
export interface PageTransitionOverlayHandle {
  scrim: HTMLDivElement | null
  caret: HTMLDivElement | null
}

/**
 * Page-transition overlay (docs/design/landing-redesign.md §M.3/§M.3.0
 * HOTFIX) — two independent layers, NOT a full-screen `bg-primary` fill
 * (that design was removed: owner feedback "very fast, hits the eyes,
 * epilepsy risk for some"; §M.3.0 has the WCAG 2.3.1 General Flash
 * Threshold calculation proving the new design can't trip that check
 * regardless of navigation frequency, which the old one only avoided by
 * assuming a human can't click fast enough).
 *
 * 1. **Scrim** — `fixed inset-0`, `background: var(--background)` (the SAME
 *    token as the page background, not a new color), opacity-animated
 *    0 → 0.94 → 0. Technically hides the instant `Outlet` swap; the
 *    near-zero luminance delta vs the already-dark page makes it safe at
 *    any repeat frequency.
 * 2. **Caret-line** — a thin (`w-16` = 64px) `transparent → primary →
 *    transparent` gradient band, `fixed inset-y-0`, that sweeps across the
 *    viewport via `translateX` ONCE per navigation, on top of the
 *    (already-darkened) scrim — reads as "a cursor typing the new page",
 *    the metaphor the owner asked for, without ever being a bright
 *    full-screen flash. 64px is a small enough fraction of any real
 *    viewport width to stay under WCAG's 25%-of-visual-field threshold
 *    (§M.3.0).
 *
 * Both layers are driven imperatively via framer-motion's standalone
 * `animate()` DOM API (see `lib/scrim-transition.ts`), never via
 * `whileInView`/`variants` — this is router-event-driven, not scroll- or
 * hover-driven. Always `pointer-events-none` so neither layer EVER blocks a
 * click, even mid-sweep.
 */
export const PageTransitionOverlay = forwardRef<PageTransitionOverlayHandle>(
  function PageTransitionOverlay(_props, ref) {
    const scrimRef = useRef<HTMLDivElement>(null)
    const caretRef = useRef<HTMLDivElement>(null)

    useImperativeHandle(
      ref,
      () => ({
        get scrim() {
          return scrimRef.current
        },
        get caret() {
          return caretRef.current
        },
      }),
      [],
    )

    return (
      <>
        <div
          ref={scrimRef}
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-[999] bg-background"
          style={{ opacity: 0, willChange: 'opacity' }}
        />
        <div
          ref={caretRef}
          aria-hidden="true"
          className="pointer-events-none fixed inset-y-0 left-0 z-[1000] w-16 [background:linear-gradient(to_right,transparent_0%,var(--primary)_47%,var(--primary)_53%,transparent_100%)]"
          style={{ transform: 'translateX(-15vw)', willChange: 'transform' }}
        />
      </>
    )
  },
)
